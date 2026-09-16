import { StudentRide } from '../models/StudentRide.js';
import { StudentRideEvent } from '../models/StudentRideEvent.js';
import { STUDENT_RIDE_EVENTS, STUDENT_RIDE_STATUS } from '../constants/index.js';
import { emitStudentRideStatus } from '../socket/emitters.js';

/**
 * Carry the dispatch ride's lifecycle onto its StudentRide companion.
 *
 * A student ride is two documents: the dispatch Ride the driver app drives, and
 * the StudentRide holding the safety workflow. Only the booking wrote the link
 * between them, so the companion stayed BOOKED for the whole trip and the
 * parent's app never left "finding driver" — it polls the companion's status,
 * which nothing was moving.
 *
 * This is the missing half, and it mirrors syncDeliveryWithRide: called from the
 * same points in the dispatch engine, a no-op for anything that is not a student
 * ride, and never allowed to fail the dispatch operation that called it.
 */

/**
 * The student lifecycle in order. Transitions are strict, so reaching a status
 * several steps ahead means walking the chain rather than jumping.
 */
const CHAIN = [
  STUDENT_RIDE_STATUS.BOOKED,
  STUDENT_RIDE_STATUS.DRIVER_ASSIGNED,
  STUDENT_RIDE_STATUS.DRIVER_ARRIVING,
  STUDENT_RIDE_STATUS.DRIVER_ARRIVED,
  STUDENT_RIDE_STATUS.PICKUP_OTP_VERIFIED,
  STUDENT_RIDE_STATUS.RIDE_STARTED,
  STUDENT_RIDE_STATUS.NEAR_DESTINATION,
  STUDENT_RIDE_STATUS.DROP_OTP_VERIFIED,
  STUDENT_RIDE_STATUS.COMPLETED,
];

/**
 * Dispatch liveStatus to the furthest student status it implies.
 *
 * `arriving` maps to DRIVER_ARRIVED rather than DRIVER_ARRIVING because that is
 * the event on which the dispatch engine stamps `arrivedAt` — it is the driver
 * reporting arrival at the pickup, not travel towards it. The chain still passes
 * through DRIVER_ARRIVING on the way, so the timeline keeps both entries.
 *
 * `arrived` means arrival at the destination in this engine, which is why it
 * sits after `started` in RIDE_LIVE_STATUS and maps to NEAR_DESTINATION.
 */
const TARGET_FOR_LIVE_STATUS = Object.freeze({
  accepted: STUDENT_RIDE_STATUS.DRIVER_ASSIGNED,
  arriving: STUDENT_RIDE_STATUS.DRIVER_ARRIVED,
  started: STUDENT_RIDE_STATUS.RIDE_STARTED,
  arrived: STUDENT_RIDE_STATUS.NEAR_DESTINATION,
  completed: STUDENT_RIDE_STATUS.COMPLETED,
});

/** Statuses from which nothing further should be synced. */
const SETTLED = [
  STUDENT_RIDE_STATUS.COMPLETED,
  STUDENT_RIDE_STATUS.CANCELLED,
  STUDENT_RIDE_STATUS.NO_SHOW,
  STUDENT_RIDE_STATUS.FAILED,
];

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
});

const appendEvent = async ({ studentRide, eventType, oldStatus, newStatus, description, metadata }) => {
  await StudentRideEvent.create({
    studentRideId: studentRide._id,
    eventType,
    oldStatus: oldStatus || '',
    newStatus: newStatus || '',
    description: description || '',
    metadata: metadata || {},
    // The dispatch engine moved it, not a person acting on this module.
    createdBy: { role: 'system', id: null },
  });
};

/**
 * Pass a verification point that never happened.
 *
 * The dispatch engine has no OTP step: a driver can report "started" without the
 * pickup code ever being entered. Refusing to advance would leave the parent
 * watching "finding driver" for the whole journey, which is the bug being fixed.
 * Advancing while marking the OTP verified would be worse — it is the exact
 * falsehood removed from the v1 implementation, where `studentOtpVerifiedAt` was
 * stamped on ride start with nothing checked.
 *
 * So the status advances, the OTP stays unverified, and the bypass is recorded
 * as its own event and its own flag. The record says a child was collected
 * without the code being checked, because that is what happened.
 */
const recordBypass = async ({ studentRide, status }) => {
  const isPickup = status === STUDENT_RIDE_STATUS.PICKUP_OTP_VERIFIED;

  if (isPickup) {
    studentRide.otpBypassed.pickup = true;
  } else {
    studentRide.otpBypassed.drop = true;
  }

  await appendEvent({
    studentRide,
    eventType: isPickup
      ? STUDENT_RIDE_EVENTS.PICKUP_OTP_BYPASSED
      : STUDENT_RIDE_EVENTS.DROP_OTP_BYPASSED,
    oldStatus: studentRide.status,
    newStatus: status,
    description: isPickup
      ? 'Trip started without the pickup OTP being verified.'
      : 'Trip completed without the drop OTP being verified.',
  });
};

/**
 * Advance one step, recording the event.
 *
 * Deliberately not routed through applyTransition: this walks the chain it owns,
 * and importing studentRideService here would pull fareService and rideService
 * back into the dispatch engine that calls this.
 */
const step = async ({ studentRide, status }) => {
  const isOtpGate = status === STUDENT_RIDE_STATUS.PICKUP_OTP_VERIFIED
    || status === STUDENT_RIDE_STATUS.DROP_OTP_VERIFIED;

  const alreadyVerified = status === STUDENT_RIDE_STATUS.PICKUP_OTP_VERIFIED
    ? Boolean(studentRide.pickupOtp?.verifiedAt)
    : Boolean(studentRide.dropOtp?.verifiedAt);

  if (isOtpGate && !alreadyVerified) {
    await recordBypass({ studentRide, status });
  }

  const previous = studentRide.status;
  studentRide.status = status;

  if (status === STUDENT_RIDE_STATUS.RIDE_STARTED && !studentRide.startedAt) {
    studentRide.startedAt = new Date();
  }

  if (status === STUDENT_RIDE_STATUS.COMPLETED && !studentRide.completedAt) {
    studentRide.completedAt = new Date();
  }

  if (!isOtpGate || !alreadyVerified) {
    await appendEvent({
      studentRide,
      eventType: EVENT_FOR_STATUS[status] || STUDENT_RIDE_EVENTS.RIDE_STARTED,
      oldStatus: previous,
      newStatus: status,
      description: `Synced from the dispatch ride (${status}).`,
    });
  }
};

/**
 * Resolve the socket server at call time.
 *
 * A static import would run through dispatchService back into rideService, which
 * is where this function is called from.
 */
const resolveSocketServer = async () => {
  try {
    const { getSocketServer } = await import('../../services/dispatchService.js');
    return getSocketServer();
  } catch {
    return null;
  }
};

export const syncStudentRideWithDispatch = async (ride) => {
  try {
    if (!ride || ride.serviceType !== 'student' || !ride.studentRideId) {
      return null;
    }

    const studentRide = await StudentRide.findById(ride.studentRideId);

    if (!studentRide || SETTLED.includes(studentRide.status)) {
      return null;
    }

    // Cancellation short-circuits the chain: there is no walking to be done.
    if (ride.liveStatus === 'cancelled' || ride.status === 'cancelled') {
      const previous = studentRide.status;
      studentRide.status = STUDENT_RIDE_STATUS.CANCELLED;
      studentRide.cancelledAt = studentRide.cancelledAt || new Date();
      studentRide.cancelledBy = studentRide.cancelledBy || 'system';
      await studentRide.save();

      await appendEvent({
        studentRide,
        eventType: STUDENT_RIDE_EVENTS.RIDE_CANCELLED,
        oldStatus: previous,
        newStatus: studentRide.status,
        description: 'Synced from the dispatch ride (cancelled).',
      });

      emitStudentRideStatus(await resolveSocketServer(), studentRide);
      return studentRide;
    }

    const target = TARGET_FOR_LIVE_STATUS[ride.liveStatus];

    if (!target) {
      return null;
    }

    const currentIndex = CHAIN.indexOf(studentRide.status);
    const targetIndex = CHAIN.indexOf(target);

    // Idempotent, and never runs backwards: a re-sync of an already-advanced
    // ride, or a dispatch status behind the companion, does nothing.
    if (currentIndex < 0 || targetIndex <= currentIndex) {
      return studentRide;
    }

    for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
      await step({ studentRide, status: CHAIN[index] });
    }

    await studentRide.save();
    emitStudentRideStatus(await resolveSocketServer(), studentRide);

    return studentRide;
  } catch (error) {
    // Never fail the dispatch call. A driver must still be able to complete a
    // trip if this sync breaks; the companion falling behind is recoverable,
    // a driver stuck mid-journey is not.
    console.error('[student-ride] status sync failed', error?.message || error);
    return null;
  }
};
