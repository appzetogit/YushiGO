import mongoose from 'mongoose';
import { StudentRide } from '../models/StudentRide.js';
import { StudentRideEvent } from '../models/StudentRideEvent.js';
import { Student } from '../models/Student.js';
import {
  STUDENT_RIDE_CANCELLABLE,
  STUDENT_RIDE_ERROR_CODES,
  STUDENT_RIDE_EVENTS,
  STUDENT_RIDE_STATUS,
  STUDENT_RIDE_TRANSITIONS,
} from '../constants/index.js';
import { requireOwnedStudent, studentRideError } from './studentService.js';
import { requireOwnedSavedLocation } from './savedLocationService.js';
import { issueOtp, serializeOtpState, verifyOtp } from './otpService.js';
import { listEmergencyContacts } from './guardianService.js';

/**
 * Append an event in the caller's transaction (§75).
 *
 * Status changes and their audit entries are written together, so the ride and
 * its timeline cannot disagree about what happened.
 */
export const recordEvent = async ({
  studentRideId,
  eventType,
  oldStatus = '',
  newStatus = '',
  description = '',
  metadata = {},
  createdBy = { role: 'system', id: null },
  session,
}) => {
  await StudentRideEvent.create([{
    studentRideId,
    eventType,
    oldStatus,
    newStatus,
    description,
    metadata,
    createdBy,
  }], { session });
};

/**
 * Move a ride to a new status, or refuse.
 *
 * Every status change goes through here. A transition absent from the table is
 * rejected, so a ride cannot skip a pickup verification or be completed twice —
 * §16 requires this to be enforced rather than assumed from client ordering.
 */
export const applyTransition = ({ ride, nextStatus }) => {
  const allowed = STUDENT_RIDE_TRANSITIONS[ride.status] || [];

  if (!allowed.includes(nextStatus)) {
    throw studentRideError(
      409,
      STUDENT_RIDE_ERROR_CODES.INVALID_RIDE_STATUS,
      `A ride cannot move from ${ride.status} to ${nextStatus}.`,
    );
  }

  const previous = ride.status;
  ride.status = nextStatus;

  return previous;
};

/**
 * Which audit event a status change produces. Explicit rather than derived:
 * several statuses have differently named events, and a lookup miss used to
 * fall through to the wrong one.
 */
const EVENT_FOR_STATUS = Object.freeze({
  DRIVER_ASSIGNED: STUDENT_RIDE_EVENTS.DRIVER_ASSIGNED,
  DRIVER_ARRIVING: STUDENT_RIDE_EVENTS.DRIVER_ARRIVING,
  DRIVER_ARRIVED: STUDENT_RIDE_EVENTS.DRIVER_ARRIVED,
  PICKUP_OTP_VERIFIED: STUDENT_RIDE_EVENTS.PICKUP_OTP_VERIFIED,
  RIDE_STARTED: STUDENT_RIDE_EVENTS.RIDE_STARTED,
  NEAR_DESTINATION: STUDENT_RIDE_EVENTS.NEAR_DESTINATION,
  DROP_OTP_VERIFIED: STUDENT_RIDE_EVENTS.DROP_OTP_VERIFIED,
  COMPLETED: STUDENT_RIDE_EVENTS.RIDE_COMPLETED,
  CANCELLED: STUDENT_RIDE_EVENTS.RIDE_CANCELLED,
  NO_SHOW: STUDENT_RIDE_EVENTS.RIDE_CANCELLED,
  FAILED: STUDENT_RIDE_EVENTS.RIDE_CANCELLED,
});

export const serializeStudentRide = (ride, { student = null, timeline = null } = {}) => ({
  studentRideId: String(ride._id),
  rideId: String(ride.rideId),
  status: ride.status,
  student: student
    ? { id: String(student._id), name: student.name, profilePhotoUrl: student.profilePhotoUrl || '' }
    : { id: String(ride.studentId) },
  pickup: ride.pickup,
  destination: ride.destination,
  scheduledAt: ride.scheduledAt,
  // State only — never the codes themselves (§42).
  pickupOtp: serializeOtpState(ride.pickupOtp),
  dropOtp: serializeOtpState(ride.dropOtp),
  startedAt: ride.startedAt,
  completedAt: ride.completedAt,
  cancelledAt: ride.cancelledAt,
  cancelledBy: ride.cancelledBy,
  cancellationReason: ride.cancellationReason || '',
  createdAt: ride.createdAt,
  ...(timeline ? { timeline } : {}),
});

const snapshotFromSavedLocation = (location) => ({
  savedLocationId: location._id,
  label: location.label,
  address: location.address,
  latitude: location.latitude,
  longitude: location.longitude,
  placeId: location.placeId || '',
});

const snapshotFromPayload = (value, field) => {
  const address = String(value?.address || '').trim();
  const latitude = Number(value?.latitude ?? value?.lat);
  const longitude = Number(value?.longitude ?? value?.lng);

  if (!address || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw studentRideError(
      422,
      STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND,
      `${field} needs an address and valid coordinates.`,
    );
  }

  return {
    savedLocationId: null,
    label: String(value?.label || '').trim().toUpperCase(),
    address,
    latitude,
    longitude,
    placeId: String(value?.placeId || value?.place_id || '').trim(),
  };
};

/**
 * Resolve one end of the journey.
 *
 * A saved-location id is verified against both the student and the caller
 * before use, so one student's address cannot be attached to another's ride
 * (§62). Either way the result is a snapshot, not a reference.
 */
const resolveEndpoint = async ({ savedLocationId, inline, studentId, userId, field, session }) => {
  if (savedLocationId) {
    const location = await requireOwnedSavedLocation(
      { locationId: savedLocationId, studentId, userId },
      { session },
    );

    return snapshotFromSavedLocation(location);
  }

  if (inline) {
    return snapshotFromPayload(inline, field);
  }

  throw studentRideError(
    422,
    STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND,
    `${field} requires either a saved location id or an inline address.`,
  );
};

/**
 * Book a student ride.
 *
 * `createDispatchRide` is injected so this service does not import the taxi ride
 * engine directly: the caller supplies it, which keeps the dependency one-way
 * and lets the tests exercise the whole flow without a dispatcher running.
 */
export const createStudentRide = async ({ userId, payload, createDispatchRide }) => {
  const student = await requireOwnedStudent({ studentId: payload?.student_id ?? payload?.studentId, userId });

  const scheduledAt = payload?.scheduled_at ?? payload?.scheduledAt
    ? new Date(payload.scheduled_at ?? payload.scheduledAt)
    : null;

  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
    throw studentRideError(422, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'scheduled_at is not a valid time.');
  }

  const session = await mongoose.startSession();

  try {
    let created;

    await session.withTransaction(async () => {
      const pickup = await resolveEndpoint({
        savedLocationId: payload?.pickup_saved_location_id ?? payload?.pickupSavedLocationId,
        inline: payload?.pickup,
        studentId: student._id,
        userId,
        field: 'pickup',
        session,
      });

      const destination = await resolveEndpoint({
        savedLocationId: payload?.destination_saved_location_id ?? payload?.destinationSavedLocationId,
        inline: payload?.destination ?? payload?.drop,
        studentId: student._id,
        userId,
        field: 'destination',
        session,
      });

      // The dispatch ride is created first: without it there is nothing for a
      // driver to be matched to, and a student ride with no ride would be an
      // orphan the dispatcher never sees.
      const dispatchRide = await createDispatchRide({
        userId,
        pickup,
        destination,
        scheduledAt,
        payload,
        session,
      });

      const pickupCode = issueOtp();

      const [studentRide] = await StudentRide.create([{
        userId,
        studentId: student._id,
        rideId: dispatchRide._id,
        pickup,
        destination,
        scheduledAt,
        status: STUDENT_RIDE_STATUS.BOOKED,
        pickupOtp: pickupCode.fields,
      }], { session });

      await recordEvent({
        studentRideId: studentRide._id,
        eventType: STUDENT_RIDE_EVENTS.RIDE_BOOKED,
        newStatus: STUDENT_RIDE_STATUS.BOOKED,
        description: 'Ride booked.',
        metadata: { pickup: pickup.address, destination: destination.address },
        createdBy: { role: 'user', id: userId },
        session,
      });

      await recordEvent({
        studentRideId: studentRide._id,
        eventType: STUDENT_RIDE_EVENTS.PICKUP_OTP_ISSUED,
        description: 'Pickup OTP issued.',
        createdBy: { role: 'system', id: null },
        session,
      });

      created = {
        ride: studentRide,
        student,
        // Returned once, here, and never persisted or logged in the clear.
        pickupOtp: pickupCode.otp,
      };
    });

    return {
      ...serializeStudentRide(created.ride, { student: created.student }),
      pickupOtp: created.pickupOtp,
    };
  } finally {
    await session.endSession();
  }
};

export const requireOwnedStudentRide = async ({ studentRideId, userId }, { session = null } = {}) => {
  if (!mongoose.Types.ObjectId.isValid(String(studentRideId || ''))) {
    throw studentRideError(404, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
  }

  const query = StudentRide.findById(studentRideId);

  if (session) {
    query.session(session);
  }

  const ride = await query;

  if (!ride || String(ride.userId) !== String(userId)) {
    throw studentRideError(404, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
  }

  return ride;
};

/**
 * Load a ride for OTP verification, including the hashes.
 *
 * `pickupOtp.hash` and `dropOtp.hash` are `select: false`, so they are absent
 * from every ordinary read and have to be asked for here explicitly.
 */
const loadRideWithOtps = async (studentRideId, session) => {
  const query = StudentRide.findById(studentRideId).select('+pickupOtp.hash +dropOtp.hash');

  if (session) {
    query.session(session);
  }

  return query;
};

/**
 * Verify a pickup or drop code.
 *
 * The driver assigned to the underlying dispatch ride is the actor: the student
 * shows the code, the driver enters it. `assertDriverForRide` is injected so
 * ownership is checked against the live dispatch record rather than a copy.
 */
export const verifyRideOtp = async ({
  studentRideId,
  kind,
  otp,
  actor,
  assertDriverForRide,
}) => {
  const isPickup = kind === 'pickup';
  const field = isPickup ? 'pickupOtp' : 'dropOtp';
  const nextStatus = isPickup
    ? STUDENT_RIDE_STATUS.PICKUP_OTP_VERIFIED
    : STUDENT_RIDE_STATUS.DROP_OTP_VERIFIED;

  const ride = await loadRideWithOtps(studentRideId, null);

  if (!ride) {
    throw studentRideError(404, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
  }

  if (assertDriverForRide) {
    await assertDriverForRide({ rideId: ride.rideId, driverId: actor.id });
  }

  // Checked before the status rule so a replay is named for what it is. After a
  // successful verification the ride has already moved on, and a status error
  // would tell the driver the wrong thing about why their entry was refused.
  if (ride[field]?.verifiedAt) {
    throw studentRideError(
      409,
      STUDENT_RIDE_ERROR_CODES.OTP_ALREADY_VERIFIED,
      `This ${kind} OTP has already been used.`,
    );
  }

  // Status is checked before the code, so a verification attempted at the wrong
  // point in the journey never consumes an attempt.
  const allowed = STUDENT_RIDE_TRANSITIONS[ride.status] || [];

  if (!allowed.includes(nextStatus)) {
    throw studentRideError(
      409,
      STUDENT_RIDE_ERROR_CODES.INVALID_RIDE_STATUS,
      `A ${kind} OTP cannot be verified while the ride is ${ride.status}.`,
    );
  }

  const outcome = verifyOtp({ stored: ride[field], submitted: otp, label: kind });

  if (!outcome.verified) {
    /**
     * Deliberately written outside a transaction.
     *
     * A failed attempt has to survive the rejection that follows it. Incrementing
     * inside a transaction that then throws rolls the counter back, which leaves
     * the attempt cap permanently at full and the codes open to brute force —
     * the exact hole this counter exists to close.
     */
    await StudentRide.updateOne(
      { _id: ride._id },
      { $inc: { [`${field}.attempts`]: 1 } },
    );

    await recordEvent({
      studentRideId: ride._id,
      eventType: isPickup
        ? STUDENT_RIDE_EVENTS.PICKUP_OTP_FAILED
        : STUDENT_RIDE_EVENTS.DROP_OTP_FAILED,
      description: 'Incorrect OTP submitted.',
      // Records that an attempt happened and how many have been used — never the
      // value that was tried (§53).
      metadata: { attempts: outcome.attempts },
      createdBy: { role: 'driver', id: actor.id },
      session: null,
    });

    throw studentRideError(400, STUDENT_RIDE_ERROR_CODES.INVALID_OTP, 'Incorrect OTP.');
  }

  const session = await mongoose.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      // Re-read inside the transaction: the checks above ran against an earlier
      // snapshot, and withTransaction may replay this body.
      const fresh = await loadRideWithOtps(studentRideId, session);

      if (!fresh || fresh[field]?.verifiedAt) {
        throw studentRideError(
          409,
          STUDENT_RIDE_ERROR_CODES.OTP_ALREADY_VERIFIED,
          `This ${kind} OTP has already been used.`,
        );
      }

      const previous = applyTransition({ ride: fresh, nextStatus });
      fresh[field].verifiedAt = outcome.verifiedAt;

      if (isPickup) {
        fresh.startedAt = fresh.startedAt || outcome.verifiedAt;
      }

      await fresh.save({ session });

      await recordEvent({
        studentRideId: fresh._id,
        eventType: isPickup
          ? STUDENT_RIDE_EVENTS.PICKUP_OTP_VERIFIED
          : STUDENT_RIDE_EVENTS.DROP_OTP_VERIFIED,
        oldStatus: previous,
        newStatus: fresh.status,
        description: isPickup ? 'Student boarded.' : 'Student dropped off.',
        createdBy: { role: 'driver', id: actor.id },
        session,
      });

      result = fresh;
    });

    return serializeStudentRide(result);
  } finally {
    await session.endSession();
  }
};

/**
 * Issue a fresh code, replacing any outstanding one.
 *
 * Needed because the plaintext is shown once: a rider who loses it, or one whose
 * code expired mid-journey, has no other way back. Re-issuing resets the attempt
 * counter, which is also the way out of a lockout.
 */
export const reissueOtp = async ({ studentRideId, userId, kind }) => {
  const isPickup = kind === 'pickup';
  const field = isPickup ? 'pickupOtp' : 'dropOtp';

  const session = await mongoose.startSession();

  try {
    let issued;

    await session.withTransaction(async () => {
      const ride = await requireOwnedStudentRide({ studentRideId, userId }, { session });

      if (ride[field]?.verifiedAt) {
        throw studentRideError(
          409,
          STUDENT_RIDE_ERROR_CODES.OTP_ALREADY_VERIFIED,
          `The ${kind} OTP has already been used.`,
        );
      }

      const expectedStatuses = isPickup
        ? [
          STUDENT_RIDE_STATUS.BOOKED,
          STUDENT_RIDE_STATUS.DRIVER_ASSIGNED,
          STUDENT_RIDE_STATUS.DRIVER_ARRIVING,
          STUDENT_RIDE_STATUS.DRIVER_ARRIVED,
        ]
        : [STUDENT_RIDE_STATUS.RIDE_STARTED, STUDENT_RIDE_STATUS.NEAR_DESTINATION];

      if (!expectedStatuses.includes(ride.status)) {
        throw studentRideError(
          409,
          STUDENT_RIDE_ERROR_CODES.INVALID_RIDE_STATUS,
          `A ${kind} OTP cannot be issued while the ride is ${ride.status}.`,
        );
      }

      const code = issueOtp();
      ride[field] = code.fields;
      await ride.save({ session });

      await recordEvent({
        studentRideId: ride._id,
        eventType: isPickup
          ? STUDENT_RIDE_EVENTS.PICKUP_OTP_ISSUED
          : STUDENT_RIDE_EVENTS.DROP_OTP_ISSUED,
        description: `${isPickup ? 'Pickup' : 'Drop'} OTP re-issued.`,
        createdBy: { role: 'user', id: userId },
        session,
      });

      issued = { ride, otp: code.otp };
    });

    return { ...serializeStudentRide(issued.ride), [`${kind}Otp`]: issued.otp };
  } finally {
    await session.endSession();
  }
};

/**
 * Advance the ride, used for the dispatch-driven statuses and for completion.
 *
 * The drop OTP is minted when the journey actually starts rather than at
 * booking: a code sitting unused for a scheduled ride hours away is a longer
 * window than it needs to be.
 */
export const advanceStatus = async ({ studentRideId, nextStatus, actor, expectDriverId, assertDriverForRide }) => {
  const session = await mongoose.startSession();

  try {
    let outcome;

    await session.withTransaction(async () => {
      const ride = await StudentRide.findById(studentRideId).session(session);

      if (!ride) {
        throw studentRideError(404, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
      }

      if (expectDriverId && assertDriverForRide) {
        await assertDriverForRide({ rideId: ride.rideId, driverId: expectDriverId, session });
      }

      const previous = applyTransition({ ride, nextStatus });
      let dropOtp = null;

      if (nextStatus === STUDENT_RIDE_STATUS.RIDE_STARTED) {
        ride.startedAt = ride.startedAt || new Date();
        const code = issueOtp();
        ride.dropOtp = code.fields;
        dropOtp = code.otp;
      }

      if (nextStatus === STUDENT_RIDE_STATUS.COMPLETED) {
        ride.completedAt = new Date();
      }

      await ride.save({ session });

      await recordEvent({
        studentRideId: ride._id,
        eventType: EVENT_FOR_STATUS[nextStatus] || STUDENT_RIDE_EVENTS.RIDE_STARTED,
        oldStatus: previous,
        newStatus: ride.status,
        description: `Ride moved to ${nextStatus}.`,
        createdBy: actor || { role: 'system', id: null },
        session,
      });

      if (dropOtp) {
        await recordEvent({
          studentRideId: ride._id,
          eventType: STUDENT_RIDE_EVENTS.DROP_OTP_ISSUED,
          description: 'Drop OTP issued.',
          createdBy: { role: 'system', id: null },
          session,
        });
      }

      outcome = { ride, dropOtp };
    });

    return {
      ...serializeStudentRide(outcome.ride),
      ...(outcome.dropOtp ? { dropOtp: outcome.dropOtp } : {}),
    };
  } finally {
    await session.endSession();
  }
};

export const cancelStudentRide = async ({ studentRideId, userId, reason, cancelDispatchRide }) => {
  const session = await mongoose.startSession();

  try {
    let cancelled;

    await session.withTransaction(async () => {
      const ride = await requireOwnedStudentRide({ studentRideId, userId }, { session });

      // Once a student is in the car, cancelling is not the rider's call — the
      // ride ends through drop-off, no-show or an operator decision.
      if (!STUDENT_RIDE_CANCELLABLE.includes(ride.status)) {
        throw studentRideError(
          409,
          STUDENT_RIDE_ERROR_CODES.CANCELLATION_NOT_ALLOWED,
          `A ride cannot be cancelled once it is ${ride.status}.`,
        );
      }

      const previous = applyTransition({ ride, nextStatus: STUDENT_RIDE_STATUS.CANCELLED });
      ride.cancelledAt = new Date();
      ride.cancelledBy = 'user';
      ride.cancellationReason = String(reason || '').trim();
      await ride.save({ session });

      await recordEvent({
        studentRideId: ride._id,
        eventType: STUDENT_RIDE_EVENTS.RIDE_CANCELLED,
        oldStatus: previous,
        newStatus: ride.status,
        description: 'Ride cancelled by the booking user.',
        metadata: { reason: ride.cancellationReason },
        createdBy: { role: 'user', id: userId },
        session,
      });

      cancelled = ride;
    });

    // The dispatch ride is stopped after the student ride is safely cancelled,
    // so a dispatcher failure cannot leave this document mid-transition.
    if (cancelDispatchRide) {
      await cancelDispatchRide({ rideId: cancelled.rideId, userId }).catch(() => null);
    }

    return serializeStudentRide(cancelled);
  } finally {
    await session.endSession();
  }
};

export const getStudentRide = async ({ studentRideId, userId }) => {
  const ride = await requireOwnedStudentRide({ studentRideId, userId });
  const [student, events] = await Promise.all([
    Student.findById(ride.studentId),
    StudentRideEvent.find({ studentRideId: ride._id }).sort({ createdAt: 1 }),
  ]);

  return serializeStudentRide(ride, {
    student,
    timeline: events.map((event) => ({
      eventType: event.eventType,
      oldStatus: event.oldStatus || '',
      newStatus: event.newStatus || '',
      description: event.description || '',
      at: event.createdAt,
    })),
  });
};

export const listStudentRides = async ({ userId, studentId, status, upcoming }) => {
  const filter = { userId };

  if (studentId) {
    filter.studentId = studentId;
  }

  if (status) {
    filter.status = String(status).toUpperCase();
  }

  if (upcoming) {
    filter.status = {
      $in: [
        STUDENT_RIDE_STATUS.BOOKED,
        STUDENT_RIDE_STATUS.DRIVER_ASSIGNED,
        STUDENT_RIDE_STATUS.DRIVER_ARRIVING,
        STUDENT_RIDE_STATUS.DRIVER_ARRIVED,
        STUDENT_RIDE_STATUS.PICKUP_OTP_VERIFIED,
        STUDENT_RIDE_STATUS.RIDE_STARTED,
        STUDENT_RIDE_STATUS.NEAR_DESTINATION,
      ],
    };
  }

  const rides = await StudentRide.find(filter)
    .sort(upcoming ? { scheduledAt: 1, createdAt: 1 } : { createdAt: -1 })
    .limit(100)
    .populate('studentId', 'name profilePhotoUrl');

  return rides.map((ride) => serializeStudentRide(ride, { student: ride.studentId }));
};

/** Guardians to alert for this ride — used by the SOS flow in the next gate. */
export const getRideEmergencyContacts = async (studentRideId) => {
  const ride = await StudentRide.findById(studentRideId).select('studentId');

  return ride ? listEmergencyContacts(ride.studentId) : [];
};
