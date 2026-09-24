import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { decryptField, encryptField } from '../../../../utils/fieldCrypto.js';
import { uploadDataUrlToCloudinary } from '../../../../utils/cloudinaryUpload.js';
import { Delivery } from '../models/Delivery.js';
import { Ride } from '../models/Ride.js';
import { generateOtp, hashOtp, otpMatches } from '../../services/secureOtp.js';
import { parcelConfig } from './parcelPolicy.js';

/**
 * Parcel handover: parcel verified → pickup OTP → drop OTP → delivered.
 *
 * The driver checks the parcel against the sender's photo and taps "Parcel
 * verified"; only then is the sender shown the pickup code. The pickup code
 * starts the trip and mints the drop code, which the sender passes to the
 * receiver. The drop code completes the delivery, which runs the normal ride
 * completion (payment settlement included).
 *
 * The driver never receives a code — only whether each step is done.
 */

const SECRET_FIELDS = '+handover.pickupOtp.hash +handover.pickupOtp.encrypted +handover.dropOtp.hash +handover.dropOtp.encrypted';

const TERMINAL_STATUSES = ['completed', 'cancelled'];

const parcelError = (status, code, message, details = null) => {
  const error = new ApiError(status, message, details);
  error.code = code;
  return error;
};

const mintOtp = (lifetimeMinutes) => {
  const config = parcelConfig();
  const otp = generateOtp(config.otpLength);
  const now = new Date();

  return {
    otp,
    fields: {
      hash: hashOtp(otp),
      encrypted: encryptField(otp),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + lifetimeMinutes * 60_000),
      verifiedAt: null,
      attempts: 0,
    },
  };
};

const otpState = (stored = {}) => ({
  issued: Boolean(stored?.issuedAt),
  verified: Boolean(stored?.verifiedAt),
  verifiedAt: stored?.verifiedAt || null,
  expiresAt: stored?.expiresAt || null,
  attemptsRemaining: Math.max(0, parcelConfig().otpMaxAttempts - (stored?.attempts || 0)),
});

const revealable = (stored) => Boolean(
  stored?.issuedAt
  && !stored.verifiedAt
  && stored.encrypted
  && (!stored.expiresAt || new Date(stored.expiresAt).getTime() > Date.now()),
);

/**
 * The handover block for an API response.
 *
 * `codes` is included only for the sender, and only for a code that is live —
 * the pickup code once the parcel is verified, the drop code once it is picked
 * up. Never for the driver.
 */
export const serializeHandover = (delivery, { viewerRole = 'driver' } = {}) => {
  const handover = delivery?.handover || {};

  const block = {
    enforced: parcelConfig().enforced,
    parcelVerified: Boolean(handover.parcelVerified),
    parcelVerifiedAt: handover.parcelVerifiedAt || null,
    pickupOtp: otpState(handover.pickupOtp),
    dropOtp: otpState(handover.dropOtp),
    pickedUpAt: handover.pickedUpAt || null,
    deliveredAt: handover.deliveredAt || null,
  };

  if (viewerRole === 'user') {
    block.codes = {
      pickup: revealable(handover.pickupOtp) ? decryptField(handover.pickupOtp.encrypted) || null : null,
      drop: revealable(handover.dropOtp) ? decryptField(handover.dropOtp.encrypted) || null : null,
    };
  }

  return block;
};

/** The code the sender should be showing right now, or ''. */
export const currentSenderCode = (handoverBlock) =>
  handoverBlock?.codes?.pickup || handoverBlock?.codes?.drop || '';

export const loadDeliveryHandover = async (deliveryId) => {
  if (!deliveryId) {
    return null;
  }

  return Delivery.findById(deliveryId).select(SECRET_FIELDS);
};

const loadForDriver = async ({ deliveryId, driverId }) => {
  if (!mongoose.Types.ObjectId.isValid(String(deliveryId || ''))) {
    throw parcelError(404, 'DELIVERY_NOT_FOUND', 'Delivery not found');
  }

  const delivery = await Delivery.findById(deliveryId).select(SECRET_FIELDS);

  if (!delivery) {
    throw parcelError(404, 'DELIVERY_NOT_FOUND', 'Delivery not found');
  }

  const ride = await Ride.findById(delivery.rideId);

  if (!ride || ride.serviceType !== 'parcel') {
    throw parcelError(404, 'DELIVERY_NOT_FOUND', 'Delivery not found');
  }

  // Same answer as a missing delivery: a driver learns nothing about parcels
  // that are not theirs.
  if (!ride.driverId || String(ride.driverId) !== String(driverId)) {
    throw parcelError(404, 'DELIVERY_NOT_FOUND', 'Delivery not found');
  }

  if (TERMINAL_STATUSES.includes(ride.status)) {
    throw parcelError(409, 'DELIVERY_CLOSED', `This delivery is already ${ride.status}.`);
  }

  return { delivery, ride };
};

const requireLiveStatus = (ride, allowed, message) => {
  if (!allowed.includes(ride.liveStatus)) {
    throw parcelError(409, 'PARCEL_INVALID_STEP', message, { liveStatus: ride.liveStatus });
  }
};

/**
 * Check a submitted code and record the outcome.
 *
 * A wrong code is counted with a conditional $inc — it cannot be lost to a
 * later failure, and a code already spent cannot be counted against.
 */
const checkCode = async ({ delivery, kind, submitted }) => {
  const config = parcelConfig();
  const stored = delivery.handover?.[`${kind}Otp`];
  const label = kind === 'pickup' ? 'pickup' : 'drop';

  if (!stored?.hash) {
    throw parcelError(409, 'OTP_NOT_ISSUED', `No ${label} OTP has been issued yet.`);
  }

  if (stored.verifiedAt) {
    throw parcelError(409, 'OTP_ALREADY_VERIFIED', `The ${label} OTP has already been verified.`);
  }

  if ((stored.attempts || 0) >= config.otpMaxAttempts) {
    throw parcelError(429, 'OTP_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts. Ask the sender to generate a new code.');
  }

  if (stored.expiresAt && new Date(stored.expiresAt).getTime() <= Date.now()) {
    throw parcelError(410, 'OTP_EXPIRED', `The ${label} OTP has expired. Ask the sender to generate a new code.`);
  }

  if (!otpMatches(stored.hash, submitted)) {
    const updated = await Delivery.findOneAndUpdate(
      { _id: delivery._id, [`handover.${kind}Otp.verifiedAt`]: null, [`handover.${kind}Otp.hash`]: stored.hash },
      { $inc: { [`handover.${kind}Otp.attempts`]: 1 } },
      { returnDocument: 'after' },
    );
    const attempts = updated?.handover?.[`${kind}Otp`]?.attempts ?? (stored.attempts || 0) + 1;

    throw parcelError(422, 'INVALID_OTP', `Incorrect ${label} OTP.`, {
      attemptsRemaining: Math.max(0, config.otpMaxAttempts - attempts),
    });
  }

  return stored;
};

// ---------------------------------------------------------------------------
// Side effects: sockets and push. Resolved at call time and never thrown — a
// push outage must not undo a handover that is already recorded.

const emitAfter = async (fn) => {
  try {
    await fn();
  } catch (error) {
    console.error('[parcel] handover side effect failed', error?.message || error);
  }
};

const socketServer = async () => {
  const { getSocketServer } = await import('../../services/dispatchService.js');
  return getSocketServer();
};

/** Code for the sender only — their user room, never the shared ride room. */
const sendCodeToSender = ({ ride, delivery, kind, otp, expiresAt }) => emitAfter(async () => {
  const io = await socketServer();
  io?.to(`user:${ride.userId}`).emit('delivery:otp', {
    deliveryId: String(delivery._id),
    rideId: String(ride._id),
    kind,
    otp,
    expiresAt,
  });
});

/** Progress (no codes) to everyone on the ride. */
const broadcastHandover = ({ ride, delivery, event }) => emitAfter(async () => {
  const io = await socketServer();
  const { getRideRoom } = await import('../../services/rideService.js');
  const fresh = await loadDeliveryHandover(delivery._id);
  io?.to(getRideRoom(ride._id)).emit(event, {
    deliveryId: String(delivery._id),
    rideId: String(ride._id),
    handover: serializeHandover(fresh, { viewerRole: 'driver' }),
  });
});

const pushToSender = ({ ride, delivery, title, body, type }) => emitAfter(async () => {
  const { sendPushNotificationToEntities } = await import('../../services/pushNotificationService.js');
  // The code itself is never in a push: it would sit on a lock screen.
  await sendPushNotificationToEntities({
    userIds: [String(ride.userId)],
    title,
    body,
    data: { notification_type: type, delivery_id: String(delivery._id), ride_id: String(ride._id) },
  });
});

/**
 * Advance the dispatch ride exactly as the driver's status button would, with
 * the same socket broadcast the ride controller sends afterwards.
 */
const advanceRide = async ({ ride, driverId, nextStatus }) => {
  const {
    updateRideLifecycle,
    getRideDetails,
    serializeRideRealtime,
    getRideRoom,
  } = await import('../../services/rideService.js');

  const updated = await updateRideLifecycle({ rideId: ride._id, driverId, nextStatus });

  await emitAfter(async () => {
    const io = await socketServer();

    if (!io) {
      return;
    }

    const populated = await getRideDetails(updated._id);
    const room = getRideRoom(populated._id);
    const statePayload = serializeRideRealtime(populated);

    io.to(room).emit('ride:status:updated', {
      rideId: String(populated._id),
      status: populated.status,
      liveStatus: populated.liveStatus,
      acceptedAt: populated.acceptedAt,
      arrivedAt: populated.arrivedAt,
      startedAt: populated.startedAt,
      completedAt: populated.completedAt,
    });
    io.to(room).emit('ride:state', statePayload);

    const { mirrorRideRealtimeState } = await import('../../services/rideRealtimeSyncService.js');
    mirrorRideRealtimeState(statePayload).catch(() => {});
  });

  return updated;
};

// ---------------------------------------------------------------------------

/** Driver: the parcel matches the sender's photo. Reveals the pickup code to the sender. */
export const markParcelVerified = async ({ deliveryId, driverId }) => {
  const config = parcelConfig();
  const { delivery, ride } = await loadForDriver({ deliveryId, driverId });

  // Idempotent: a second tap neither errors nor mints a second code.
  if (delivery.handover?.parcelVerified) {
    return serializeHandover(delivery, { viewerRole: 'driver' });
  }

  requireLiveStatus(
    ride,
    config.enforced ? ['arriving'] : ['accepted', 'arriving'],
    'Mark yourself arrived at the pickup before verifying the parcel.',
  );

  const now = new Date();
  const { otp, fields } = mintOtp(config.pickupOtpExpiryMinutes);

  const updated = await Delivery.findOneAndUpdate(
    { _id: delivery._id, 'handover.parcelVerified': { $ne: true } },
    {
      $set: {
        'handover.parcelVerified': true,
        'handover.parcelVerifiedAt': now,
        'handover.parcelVerifiedBy': driverId,
        'handover.pickupOtp': fields,
      },
    },
    { returnDocument: 'after' },
  ).select(SECRET_FIELDS);

  // Lost a race with a concurrent tap: that call issued the code.
  if (!updated) {
    return serializeHandover(await loadDeliveryHandover(delivery._id), { viewerRole: 'driver' });
  }

  await Ride.updateOne({ _id: ride._id }, { $set: { 'parcelHandover.parcelVerified': true } });

  await sendCodeToSender({ ride, delivery, kind: 'pickup', otp, expiresAt: fields.expiresAt });
  await broadcastHandover({ ride, delivery, event: 'delivery:parcel-verified' });
  await pushToSender({
    ride,
    delivery,
    type: 'PARCEL_VERIFIED',
    title: 'Parcel verified',
    body: 'The driver has checked your parcel. Open the app and share the pickup code.',
  });

  return serializeHandover(updated, { viewerRole: 'driver' });
};

/** Driver: the sender's pickup code. Starts the trip and issues the drop code. */
export const verifyPickupOtp = async ({ deliveryId, driverId, otp }) => {
  const config = parcelConfig();
  const { delivery, ride } = await loadForDriver({ deliveryId, driverId });

  if (!delivery.handover?.parcelVerified) {
    throw parcelError(409, 'PARCEL_NOT_VERIFIED', 'Verify the parcel before entering the pickup OTP.');
  }

  const stored = await checkCode({ delivery, kind: 'pickup', submitted: otp });
  const now = new Date();
  const drop = mintOtp(config.dropOtpExpiryMinutes);

  const updated = await Delivery.findOneAndUpdate(
    { _id: delivery._id, 'handover.pickupOtp.verifiedAt': null, 'handover.pickupOtp.hash': stored.hash },
    {
      $set: {
        'handover.pickupOtp.verifiedAt': now,
        'handover.pickedUpAt': now,
        'handover.dropOtp': drop.fields,
      },
    },
    { returnDocument: 'after' },
  ).select(SECRET_FIELDS);

  if (!updated) {
    throw parcelError(409, 'OTP_ALREADY_VERIFIED', 'The pickup OTP has already been verified.');
  }

  await Ride.updateOne({ _id: ride._id }, { $set: { 'parcelHandover.pickupOtpVerified': true } });

  // The ride may already be running if the driver started it the old way.
  if (['accepted', 'arriving'].includes(ride.liveStatus)) {
    await advanceRide({ ride, driverId, nextStatus: 'started' });
  }

  await sendCodeToSender({ ride, delivery, kind: 'drop', otp: drop.otp, expiresAt: drop.fields.expiresAt });
  await broadcastHandover({ ride, delivery, event: 'delivery:picked-up' });
  await pushToSender({
    ride,
    delivery,
    type: 'PARCEL_PICKED_UP',
    title: 'Parcel picked up',
    body: 'Your parcel is on its way. Share the drop code with the receiver.',
  });

  return serializeHandover(updated, { viewerRole: 'driver' });
};

/** Driver: the receiver's drop code. Completes the delivery, settling payment as any ride does. */
export const verifyDropOtp = async ({ deliveryId, driverId, otp }) => {
  const config = parcelConfig();
  const { delivery, ride } = await loadForDriver({ deliveryId, driverId });

  if (!delivery.handover?.pickupOtp?.verifiedAt) {
    throw parcelError(409, 'PICKUP_NOT_VERIFIED', 'The pickup OTP has not been verified for this delivery.');
  }

  requireLiveStatus(
    ride,
    config.enforced ? ['arrived'] : ['started', 'arrived'],
    'Mark yourself arrived at the drop point before entering the drop OTP.',
  );

  const stored = await checkCode({ delivery, kind: 'drop', submitted: otp });
  const now = new Date();

  const updated = await Delivery.findOneAndUpdate(
    { _id: delivery._id, 'handover.dropOtp.verifiedAt': null, 'handover.dropOtp.hash': stored.hash },
    { $set: { 'handover.dropOtp.verifiedAt': now, 'handover.deliveredAt': now } },
    { returnDocument: 'after' },
  ).select(SECRET_FIELDS);

  if (!updated) {
    throw parcelError(409, 'OTP_ALREADY_VERIFIED', 'The drop OTP has already been verified.');
  }

  await Ride.updateOne({ _id: ride._id }, { $set: { 'parcelHandover.dropOtpVerified': true } });
  await advanceRide({ ride, driverId, nextStatus: 'completed' });

  await broadcastHandover({ ride, delivery, event: 'delivery:delivered' });
  await pushToSender({
    ride,
    delivery,
    type: 'PARCEL_DELIVERED',
    title: 'Parcel delivered',
    body: 'Your parcel has been delivered.',
  });

  return serializeHandover(updated, { viewerRole: 'driver' });
};

/** Sender: a fresh code when the old one expired or was locked by wrong attempts. */
export const reissueParcelOtp = async ({ deliveryId, userId, kind }) => {
  const config = parcelConfig();

  if (!['pickup', 'drop'].includes(kind)) {
    throw parcelError(400, 'INVALID_OTP_KIND', 'kind must be pickup or drop.');
  }

  if (!mongoose.Types.ObjectId.isValid(String(deliveryId || ''))) {
    throw parcelError(404, 'DELIVERY_NOT_FOUND', 'Delivery not found');
  }

  const delivery = await Delivery.findById(deliveryId).select(SECRET_FIELDS);

  if (!delivery || String(delivery.userId) !== String(userId)) {
    throw parcelError(404, 'DELIVERY_NOT_FOUND', 'Delivery not found');
  }

  const ride = await Ride.findById(delivery.rideId).select('userId status serviceType');

  if (!ride || TERMINAL_STATUSES.includes(ride.status)) {
    throw parcelError(409, 'DELIVERY_CLOSED', 'This delivery is already closed.');
  }

  const handover = delivery.handover || {};

  if (kind === 'pickup' && !handover.parcelVerified) {
    throw parcelError(409, 'PARCEL_NOT_VERIFIED', 'The pickup code is issued once the driver verifies the parcel.');
  }

  if (kind === 'drop' && !handover.pickupOtp?.verifiedAt) {
    throw parcelError(409, 'PICKUP_NOT_VERIFIED', 'The drop code is issued once the parcel is picked up.');
  }

  if (handover[`${kind}Otp`]?.verifiedAt) {
    throw parcelError(409, 'OTP_ALREADY_VERIFIED', `The ${kind} OTP has already been verified.`);
  }

  const { otp, fields } = mintOtp(kind === 'pickup' ? config.pickupOtpExpiryMinutes : config.dropOtpExpiryMinutes);

  await Delivery.updateOne(
    { _id: delivery._id, [`handover.${kind}Otp.verifiedAt`]: null },
    { $set: { [`handover.${kind}Otp`]: fields } },
  );

  await sendCodeToSender({ ride, delivery, kind, otp, expiresAt: fields.expiresAt });

  return { kind, otp, expiresAt: fields.expiresAt };
};

const PHOTO_MIME = /^data:image\/(jpeg|jpg|png|webp);base64,/i;

/** Sender: upload the parcel photo before booking. Returns the URL to send as parcel.photoUrl. */
export const uploadParcelPhoto = async ({ userId, image }) => {
  const config = parcelConfig();
  const dataUrl = String(image || '');

  if (!PHOTO_MIME.test(dataUrl)) {
    throw parcelError(422, 'INVALID_PHOTO', 'image must be a base64 data URL of a JPEG, PNG or WebP photo.');
  }

  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bytes = Math.floor((base64.length * 3) / 4);

  if (bytes > config.maxPhotoBytes) {
    throw parcelError(413, 'PHOTO_TOO_LARGE', `The photo must be ${Math.round(config.maxPhotoBytes / 1024 / 1024)} MB or smaller.`);
  }

  const uploaded = await uploadDataUrlToCloudinary({
    dataUrl,
    folder: 'parcel-photos',
    publicIdPrefix: 'parcel',
    publicIdSuffix: String(userId || ''),
  });

  return { photoUrl: uploaded.secureUrl, bytes: uploaded.bytes ?? bytes };
};
