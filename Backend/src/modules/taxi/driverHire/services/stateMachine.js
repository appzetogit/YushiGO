import { DRIVER_HIRE_ERRORS, DRIVER_HIRE_TRANSITIONS } from '../constants/index.js';
import { DriverHireBooking } from '../models/DriverHireBooking.js';
import { audit, driverHireError, isObjectId } from './common.js';

/**
 * The one place a booking's status changes (spec §8: validate every
 * transition server-side).
 *
 * A move is a single conditional update keyed on the status it starts from, so
 * of two actors racing — a driver accepting while the customer cancels — one
 * matches and the other matches nothing and is told the booking moved on.
 */

const TIMESTAMP_FOR = {
  DRIVER_ASSIGNED: 'assignedAt',
  DRIVER_EN_ROUTE: 'enRouteAt',
  DRIVER_ARRIVED: 'arrivedAt',
  TRIP_STARTED: 'startedAt',
  TRIP_COMPLETED: 'completedAt',
  CANCELLED_BY_CUSTOMER: 'cancelledAt',
  CANCELLED_BY_DRIVER: 'cancelledAt',
  CANCELLED_BY_ADMIN: 'cancelledAt',
  EXPIRED: 'expiredAt',
};

export const canTransition = (from, to) => (DRIVER_HIRE_TRANSITIONS[from] || []).includes(to);

export const loadBooking = async (bookingId, { session = null, withOtp = false } = {}) => {
  if (!isObjectId(bookingId)) {
    throw driverHireError(404, DRIVER_HIRE_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
  }
  const query = DriverHireBooking.findById(bookingId);
  if (withOtp) query.select('+startOtp.code');
  if (session) query.session(session);
  const booking = await query;
  if (!booking) {
    throw driverHireError(404, DRIVER_HIRE_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
  }
  return booking;
};

/**
 * Move a booking from one of `from` to `to`. Returns the updated booking, or
 * throws INVALID_TRANSITION if it was no longer in a `from` state.
 *
 * `to` may equal the current status for non-status events (an offer, a
 * decline); pass `event` to label them on the timeline.
 */
export const transition = async ({
  bookingId,
  from,
  to,
  actor,
  set = {},
  push = {},
  inc = null,
  filter = {},
  event = '',
  note = '',
  session = null,
  auditSummary = null,
  conflict = null,
}) => {
  const fromList = Array.isArray(from) ? from : [from];
  for (const state of fromList) {
    if (state !== to && !canTransition(state, to)) {
      throw driverHireError(
        409,
        DRIVER_HIRE_ERRORS.INVALID_TRANSITION,
        `A ${state.toLowerCase().replace(/_/g, ' ')} booking cannot become ${to.toLowerCase().replace(/_/g, ' ')}.`,
        { status: state },
      );
    }
  }

  const now = new Date();
  const update = {
    $set: { status: to, ...set },
    $push: { timeline: { status: to, event, at: now, actorRole: actor.role, actorId: actor.id || null, note: String(note || '').slice(0, 500) }, ...push },
  };
  const stamp = TIMESTAMP_FOR[to];
  if (stamp && !event && update.$set[stamp] === undefined) update.$set[stamp] = now;
  if (inc) update.$inc = inc;

  const booking = await DriverHireBooking.findOneAndUpdate(
    { _id: bookingId, status: { $in: fromList }, ...filter },
    update,
    { returnDocument: 'after', session },
  );

  if (!booking) {
    const current = await DriverHireBooking.findById(bookingId).select('status').session(session).lean();
    if (!current) throw driverHireError(404, DRIVER_HIRE_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
    // Still in a `from` state, so it was the extra filter that failed.
    if (conflict && fromList.includes(current.status)) {
      throw driverHireError(409, conflict.code, conflict.message, { status: current.status });
    }
    throw driverHireError(
      409,
      DRIVER_HIRE_ERRORS.INVALID_TRANSITION,
      `This booking is ${current.status.toLowerCase().replace(/_/g, ' ')} and cannot be changed that way.`,
      { status: current.status },
    );
  }

  await audit({
    actorRole: actor.role,
    actorId: actor.id || null,
    action: event || `STATUS_${to}`,
    entityType: 'DriverHireBooking',
    entityId: booking._id,
    changeSummary: auditSummary || { from: fromList, to, note },
    session,
  });

  return booking;
};
