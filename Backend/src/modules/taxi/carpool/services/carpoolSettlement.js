import { CARPOOL_PAYMENT_STATUS } from '../constants/index.js';

/**
 * Settlement seam.
 *
 * Carpool currently settles as cash between the two users: the platform moves no
 * money, so every booking sits at NOT_REQUIRED. The open questions in §40 —
 * commission, capture timing, refund policy on each cancellation path — are not
 * answered yet, and guessing at them would bake assumptions into the booking
 * records themselves.
 *
 * These hooks are the only places a payment model needs to attach. A wallet or
 * gateway implementation replaces the bodies; nothing in the booking flow moves.
 */

export const onBookingRequested = async (/* { booking, ride } */) => ({
  paymentStatus: CARPOOL_PAYMENT_STATUS.NOT_REQUIRED,
});

/** Where a hold or capture would go once a host confirms a seat. */
export const onBookingAccepted = async (/* { booking, ride } */) => ({
  paymentStatus: CARPOOL_PAYMENT_STATUS.NOT_REQUIRED,
});

/**
 * Where a refund would go. The caller passes who cancelled, because the refund
 * policy differs by path: a host cancelling on a passenger is not the same as a
 * passenger dropping out.
 */
export const onBookingCancelled = async (/* { booking, ride, cancelledBy } */) => ({
  paymentStatus: CARPOOL_PAYMENT_STATUS.NOT_REQUIRED,
});

/** Where the payout to the host would be released. */
export const onRideCompleted = async (/* { ride, bookings } */) => ({
  paymentStatus: CARPOOL_PAYMENT_STATUS.NOT_REQUIRED,
});
