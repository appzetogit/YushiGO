import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { StudentRideShareToken } from '../models/StudentRideShareToken.js';
import { StudentRide } from '../models/StudentRide.js';
import { Student } from '../models/Student.js';
import { Ride } from '../../user/models/Ride.js';
import {
  STUDENT_RIDE_ERROR_CODES,
  STUDENT_RIDE_STATUS,
  studentRideConfig,
} from '../constants/index.js';
import { requireOwnedStudentRide } from './studentRideService.js';
import { studentRideError } from './studentService.js';

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Ride states a share link will serve.
 *
 * Tracking opens once there is something to watch and closes when the journey
 * ends (§65). A completed ride stops answering even while its token is inside
 * the expiry window — the link a parent still has in WhatsApp goes quiet on
 * arrival rather than reporting the driver's whereabouts afterwards.
 */
const TRACKABLE_STATUSES = Object.freeze([
  STUDENT_RIDE_STATUS.DRIVER_ASSIGNED,
  STUDENT_RIDE_STATUS.DRIVER_ARRIVING,
  STUDENT_RIDE_STATUS.DRIVER_ARRIVED,
  STUDENT_RIDE_STATUS.PICKUP_OTP_VERIFIED,
  STUDENT_RIDE_STATUS.RIDE_STARTED,
  STUDENT_RIDE_STATUS.NEAR_DESTINATION,
]);

/** Every public refusal is identical, so a caller cannot tell them apart (§33). */
const notFound = () => studentRideError(
  404,
  STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND,
  'Tracking link not found.',
);

export const createShareLink = async ({ studentRideId, userId }) => {
  const ride = await requireOwnedStudentRide({ studentRideId, userId });

  if (![...TRACKABLE_STATUSES, STUDENT_RIDE_STATUS.BOOKED].includes(ride.status)) {
    throw studentRideError(
      409,
      STUDENT_RIDE_ERROR_CODES.INVALID_RIDE_STATUS,
      `A ${ride.status.toLowerCase()} ride cannot be shared.`,
    );
  }

  // 32 bytes of CSPRNG output. Never an id, a phone number or anything else
  // guessable or enumerable (§52).
  const token = crypto.randomBytes(32).toString('hex');
  const config = studentRideConfig();

  await StudentRideShareToken.create({
    studentRideId: ride._id,
    createdBy: userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + (config.shareTokenExpiryHours * 60 * 60 * 1000)),
  });

  const baseUrl = String(process.env.STUDENT_RIDE_SHARE_BASE_URL || process.env.PUBLIC_FRONTEND_URL || '')
    .replace(/\/$/, '');

  return {
    // The plaintext is returned once, here. Only its hash is stored.
    shareUrl: `${baseUrl}/student-ride/share/${token}`,
    token,
    expiresAt: new Date(Date.now() + (config.shareTokenExpiryHours * 60 * 60 * 1000)),
  };
};

export const listShareLinks = async ({ studentRideId, userId }) => {
  await requireOwnedStudentRide({ studentRideId, userId });

  const tokens = await StudentRideShareToken.find({ studentRideId }).sort({ createdAt: -1 });

  return tokens.map((row) => ({
    shareId: String(row._id),
    // The token itself is unrecoverable by design; the owner sees only its state.
    active: !row.revokedAt && row.expiresAt.getTime() > Date.now(),
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    accessCount: row.accessCount,
    lastAccessedAt: row.lastAccessedAt,
    createdAt: row.createdAt,
  }));
};

/** Stop sharing immediately (§32). The link is dead on the next request. */
export const revokeShareLink = async ({ studentRideId, shareId, userId }) => {
  await requireOwnedStudentRide({ studentRideId, userId });

  if (!mongoose.Types.ObjectId.isValid(String(shareId || ''))) {
    throw notFound();
  }

  const token = await StudentRideShareToken.findOne({ _id: shareId, studentRideId });

  if (!token) {
    throw notFound();
  }

  if (!token.revokedAt) {
    token.revokedAt = new Date();
    await token.save();
  }

  return { shareId: String(token._id), revoked: true, revokedAt: token.revokedAt };
};

export const revokeAllShareLinks = async ({ studentRideId, session = null }) => {
  const query = StudentRideShareToken.updateMany(
    { studentRideId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );

  if (session) {
    query.session(session);
  }

  return query;
};

/**
 * Resolve a share token to the ride behind it.
 *
 * Unknown, revoked, expired and finished all raise the same 404, so the endpoint
 * cannot be used to learn whether a ride exists or whether a guessed token was
 * close (§33).
 */
const resolveToken = async (token) => {
  const raw = String(token || '').trim();

  if (!raw || !/^[a-f0-9]{64}$/i.test(raw)) {
    throw notFound();
  }

  const record = await StudentRideShareToken.findOne({ tokenHash: hashToken(raw) });

  if (!record || record.revokedAt || record.expiresAt.getTime() <= Date.now()) {
    throw notFound();
  }

  const ride = await StudentRide.findById(record.studentRideId);

  if (!ride || !TRACKABLE_STATUSES.includes(ride.status)) {
    throw notFound();
  }

  return { record, ride };
};

/**
 * The public payload (§30/§31).
 *
 * Built field by field from an allow-list rather than by trimming a fuller
 * object, because the failure mode of trimming is a field silently reappearing
 * when something upstream is added. Nothing here identifies the student beyond
 * a first name, and nothing reaches the driver off the road.
 */
const buildPublicPayload = ({ ride, student, dispatchRide }) => {
  const driver = dispatchRide?.driverId && typeof dispatchRide.driverId === 'object'
    ? dispatchRide.driverId
    : null;

  return {
    rideStatus: ride.status,
    student: {
      // First name only: a full name plus a live location is more than a
      // forwarded link needs to carry.
      displayName: String(student?.name || '').trim().split(/\s+/)[0] || 'Student',
    },
    driver: driver
      ? {
        name: driver.name || '',
        rating: driver.rating || null,
      }
      : null,
    vehicle: driver
      ? {
        number: driver.vehicleNumber || '',
        model: [driver.vehicleMake, driver.vehicleModel].filter(Boolean).join(' '),
        color: driver.vehicleColor || '',
      }
      : null,
    currentLocation: dispatchRide?.lastDriverLocation?.coordinates?.length === 2
      ? {
        latitude: dispatchRide.lastDriverLocation.coordinates[1],
        longitude: dispatchRide.lastDriverLocation.coordinates[0],
      }
      : null,
    pickupAddress: ride.pickup?.address || '',
    destinationAddress: ride.destination?.address || '',
    startedAt: ride.startedAt,
    // etaMinutes is absent until a routing provider is wired in; the shape is
    // reserved so adding it later is not a contract change (§35).
    etaMinutes: null,
    lastUpdatedAt: new Date().toISOString(),
  };
};

export const getPublicTracking = async (token) => {
  const { record, ride } = await resolveToken(token);

  const [student, dispatchRide] = await Promise.all([
    Student.findById(ride.studentId).select('name'),
    Ride.findById(ride.rideId)
      .select('driverId lastDriverLocation')
      .populate('driverId', 'name rating vehicleNumber vehicleMake vehicleModel vehicleColor'),
  ]);

  // Access is recorded but never blocks the read: a parent refreshing the page
  // must not be locked out of watching a child's ride.
  record.accessCount += 1;
  record.lastAccessedAt = new Date();
  await record.save().catch(() => null);

  return buildPublicPayload({ ride, student, dispatchRide });
};

/** Used by the socket layer to authorise a browser holding only a share token. */
export const resolveShareTokenForSocket = async (token) => {
  const { ride } = await resolveToken(token);
  return { studentRideId: String(ride._id), status: ride.status };
};
