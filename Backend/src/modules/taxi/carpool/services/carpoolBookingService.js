import mongoose from 'mongoose';
import { CarpoolBooking } from '../models/CarpoolBooking.js';
import { CarpoolRide } from '../models/CarpoolRide.js';
import {
  CARPOOL_BOOKING_STATUS,
  CARPOOL_ERRORS,
  CARPOOL_RIDE_STATUS,
  carpoolConfig,
} from '../constants/index.js';
import { carpoolError } from './carpoolVehicleService.js';
import { requireOwnedRide } from './carpoolRideService.js';
import * as settlement from './carpoolSettlement.js';
import { notifyCarpool } from './carpoolNotifications.js';
import { runInTransaction } from './transaction.js';
import { recordCompletedTrips } from './carpoolRatingService.js';
import { emitCarpoolRideStatus } from '../socket/carpoolSocketHandler.js';
import { getSocketServer } from '../../services/dispatchService.js';

/**
 * Send notifications only after a transaction has committed.
 *
 * runInTransaction replays its callback on a transient conflict, so a push sent
 * from inside would go out again on every attempt — and could announce a booking
 * that then failed to commit at all.
 */
const flushNotifications = async (queued = []) => {
  for (const [type, context] of queued) {
    await notifyCarpool(type, context);
  }
};

const BOOKABLE_RIDE_STATUSES = [CARPOOL_RIDE_STATUS.PUBLISHED];

export const serializeBooking = (booking, { ride = null } = {}) => ({
  bookingId: String(booking._id),
  rideId: String(booking.rideId?._id || booking.rideId),
  seatCount: booking.seatCount,
  pickup: booking.pickup,
  drop: booking.drop,
  pricePerSeat: booking.pricePerSeat,
  totalAmount: booking.totalAmount,
  status: booking.status,
  paymentStatus: booking.paymentStatus,
  cancellationReason: booking.cancellationReason || '',
  cancelledBy: booking.cancelledBy,
  createdAt: booking.createdAt,
  acceptedAt: booking.acceptedAt,
  ...(ride
    ? {
        ride: {
          origin: ride.origin?.name || '',
          destination: ride.destination?.name || '',
          date: ride.date,
          departureTime: ride.departureTime,
          departureAt: ride.departureAt,
          status: ride.status,
        },
      }
    : {}),
});

/**
 * Identity shown to the other party — no phone, no email (§42).
 *
 * `fallbackId` keeps the reference intact when populate resolves to null,
 * which happens if the account was since deleted.
 */
const serializePassenger = (user, fallbackId = null) => ({
  id: String(user?._id || (user && !user.name ? user : '') || fallbackId || ''),
  name: user?.name || '',
  profileImage: user?.profileImage || '',
});

const parsePlace = (value, field, errorCode) => {
  const name = String(value?.name || '').trim();
  const latitude = Number(value?.lat ?? value?.latitude);
  const longitude = Number(value?.lng ?? value?.longitude);

  if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw carpoolError(422, errorCode, `${field} must have a name and valid coordinates.`);
  }

  return { name, latitude, longitude };
};

/**
 * Reserve seats on a ride, atomically.
 *
 * The guard lives in the query, not in code that read the ride first: the
 * conditional update only matches while enough seats remain, so two concurrent
 * acceptances for the last seat cannot both succeed. Whichever loses the race
 * matches nothing and is told the seats are gone.
 *
 * This is what makes §18 hold — a read-then-write would leave exactly the window
 * the specification warns about.
 */
const reserveSeats = async ({ rideId, seats, session }) => {
  const ride = await CarpoolRide.findOneAndUpdate(
    {
      _id: rideId,
      status: { $in: BOOKABLE_RIDE_STATUSES },
      $expr: { $gte: [{ $subtract: ['$offeredSeats', '$bookedSeats'] }, seats] },
    },
    { $inc: { bookedSeats: seats } },
    { returnDocument: 'after', session },
  );

  if (!ride) {
    return null;
  }

  // A ride with no seats left stops appearing in search without being cancelled.
  if (ride.bookedSeats >= ride.offeredSeats && ride.status === CARPOOL_RIDE_STATUS.PUBLISHED) {
    ride.status = CARPOOL_RIDE_STATUS.FULL;
    await ride.save({ session });
  }

  return ride;
};

/** Give seats back and reopen the ride if it had filled. */
const releaseSeats = async ({ rideId, seats, session }) => {
  if (!seats) {
    return;
  }

  // Guarded so the counter can never be driven below zero (§47); if fewer seats
  // are held than we are releasing, the state is already inconsistent and is
  // clamped rather than made worse.
  let ride = await CarpoolRide.findOneAndUpdate(
    { _id: rideId, bookedSeats: { $gte: seats } },
    { $inc: { bookedSeats: -seats } },
    { returnDocument: 'after', session },
  );

  if (!ride) {
    ride = await CarpoolRide.findOneAndUpdate(
      { _id: rideId },
      { $set: { bookedSeats: 0 } },
      { returnDocument: 'after', session },
    );
  }

  if (ride && ride.status === CARPOOL_RIDE_STATUS.FULL && ride.bookedSeats < ride.offeredSeats) {
    ride.status = CARPOOL_RIDE_STATUS.PUBLISHED;
    await ride.save({ session });
  }
};

export const createBooking = async ({ rideId, userId, payload }) => {
  const config = carpoolConfig();

  if (!mongoose.Types.ObjectId.isValid(String(rideId || ''))) {
    throw carpoolError(404, CARPOOL_ERRORS.RIDE_NOT_FOUND, 'Ride not found.');
  }

  const seatCount = Number(payload?.seat_count ?? payload?.seatCount ?? 1);

  if (!Number.isInteger(seatCount) || seatCount < 1 || seatCount > config.maxSeatsPerBooking) {
    throw carpoolError(
      422,
      CARPOOL_ERRORS.SEATS_UNAVAILABLE,
      `seat_count must be a whole number between 1 and ${config.maxSeatsPerBooking}.`,
    );
  }

  const notifications = [];

  const result = await runInTransaction(async (session) => {
    // Cleared per attempt so a retry does not re-queue the previous attempt's work.
    notifications.length = 0;

    const ride = await CarpoolRide.findById(rideId).session(session);

    if (!ride) {
      throw carpoolError(404, CARPOOL_ERRORS.RIDE_NOT_FOUND, 'Ride not found.');
    }

    if (String(ride.driverId) === String(userId)) {
      throw carpoolError(422, CARPOOL_ERRORS.CANNOT_BOOK_OWN_RIDE, 'You cannot book a seat on your own ride.');
    }

    if (!BOOKABLE_RIDE_STATUSES.includes(ride.status)) {
      throw carpoolError(409, CARPOOL_ERRORS.RIDE_NOT_AVAILABLE, `This ride is ${ride.status.toLowerCase()}.`);
    }

    if (ride.departureAt.getTime() <= Date.now()) {
      throw carpoolError(409, CARPOOL_ERRORS.RIDE_NOT_AVAILABLE, 'This ride has already departed.');
    }

    // A request holds nothing, so this is an early courtesy check; the binding
    // guarantee is the conditional update at acceptance.
    if ((ride.offeredSeats - ride.bookedSeats) < seatCount) {
      throw carpoolError(409, CARPOOL_ERRORS.SEATS_UNAVAILABLE, 'Not enough seats available.');
    }

    const pickup = parsePlace(payload?.pickup, 'pickup', CARPOOL_ERRORS.INVALID_PICKUP);
    const drop = parsePlace(payload?.drop, 'drop', CARPOOL_ERRORS.INVALID_DROP);

    const instant = config.instantBooking;
    let seatsHeld = 0;

    if (instant) {
      const reserved = await reserveSeats({ rideId: ride._id, seats: seatCount, session });

      if (!reserved) {
        throw carpoolError(409, CARPOOL_ERRORS.SEATS_UNAVAILABLE, 'Not enough seats available.');
      }

      seatsHeld = seatCount;
    }

    const payment = instant
      ? await settlement.onBookingAccepted({ ride })
      : await settlement.onBookingRequested({ ride });

    let booking;

    try {
      [booking] = await CarpoolBooking.create([{
        rideId: ride._id,
        passengerId: userId,
        // Taken from the ride, never from the request body (§17).
        driverId: ride.driverId,
        seatCount,
        pickup,
        drop,
        pricePerSeat: ride.pricePerSeat,
        totalAmount: Math.round(ride.pricePerSeat * seatCount * 100) / 100,
        status: instant ? CARPOOL_BOOKING_STATUS.ACCEPTED : CARPOOL_BOOKING_STATUS.PENDING,
        paymentStatus: payment.paymentStatus,
        isActive: true,
        seatsHeld,
        acceptedAt: instant ? new Date() : null,
      }], { session });
    } catch (error) {
      // The partial unique index caught a repeat of a request this passenger
      // already has open — a double tap or a retried call, not a new booking.
      if (error?.code === 11000) {
        throw carpoolError(
          409,
          CARPOOL_ERRORS.DUPLICATE_BOOKING,
          'You already have an active booking on this ride.',
        );
      }

      throw error;
    }


    notifications.push([instant ? 'CARPOOL_REQUEST_ACCEPTED' : 'CARPOOL_RIDE_REQUEST', { ride, booking }]);

    return serializeBooking(booking, { ride });
  });

  await flushNotifications(notifications);

  return result;
};

const requireBookingForDriver = async ({ bookingId, userId, session }) => {
  if (!mongoose.Types.ObjectId.isValid(String(bookingId || ''))) {
    throw carpoolError(404, CARPOOL_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
  }

  const booking = await CarpoolBooking.findById(bookingId).session(session);

  if (!booking) {
    throw carpoolError(404, CARPOOL_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
  }

  if (String(booking.driverId) !== String(userId)) {
    throw carpoolError(403, CARPOOL_ERRORS.UNAUTHORIZED_RIDE_ACCESS, 'You do not own this ride.');
  }

  return booking;
};

export const acceptBooking = async ({ bookingId, userId }) => {
  const notifications = [];

  const result = await runInTransaction(async (session) => {
    // Cleared per attempt so a retry does not re-queue the previous attempt's work.
    notifications.length = 0;

    const booking = await requireBookingForDriver({ bookingId, userId, session });

    if (booking.status !== CARPOOL_BOOKING_STATUS.PENDING) {
      throw carpoolError(
        409,
        CARPOOL_ERRORS.BOOKING_ALREADY_PROCESSED,
        `This booking is already ${booking.status.toLowerCase()}.`,
      );
    }

    // Seats are taken here, not at request time, so this is the moment the race
    // is decided between two pending requests for the same remaining seat.
    const ride = await reserveSeats({ rideId: booking.rideId, seats: booking.seatCount, session });

    if (!ride) {
      throw carpoolError(409, CARPOOL_ERRORS.SEATS_UNAVAILABLE, 'Not enough seats remain to accept this request.');
    }

    const payment = await settlement.onBookingAccepted({ booking, ride });

    booking.status = CARPOOL_BOOKING_STATUS.ACCEPTED;
    booking.paymentStatus = payment.paymentStatus;
    booking.acceptedAt = new Date();
    booking.seatsHeld = booking.seatCount;
    await booking.save({ session });

    notifications.push(['CARPOOL_REQUEST_ACCEPTED', { ride, booking }]);

    return serializeBooking(booking, { ride });
  });

  await flushNotifications(notifications);

  return result;
};

export const rejectBooking = async ({ bookingId, userId, reason }) => {
  const notifications = [];

  const result = await runInTransaction(async (session) => {
    // Cleared per attempt so a retry does not re-queue the previous attempt's work.
    notifications.length = 0;

    const booking = await requireBookingForDriver({ bookingId, userId, session });

    if (booking.status !== CARPOOL_BOOKING_STATUS.PENDING) {
      throw carpoolError(
        409,
        CARPOOL_ERRORS.BOOKING_ALREADY_PROCESSED,
        `This booking is already ${booking.status.toLowerCase()}.`,
      );
    }

    booking.status = CARPOOL_BOOKING_STATUS.REJECTED;
    booking.rejectedAt = new Date();
    // Clearing isActive frees the partial unique index, so the passenger may
    // request again — perhaps with a pickup the host finds workable.
    booking.isActive = false;
    booking.cancellationReason = String(reason || '').trim();
    await booking.save({ session });

    notifications.push(['CARPOOL_REQUEST_REJECTED', { booking }]);

    return serializeBooking(booking);
  });

  await flushNotifications(notifications);

  return result;
};

export const cancelBookingByPassenger = async ({ bookingId, userId, reason }) => {
  const notifications = [];

  const result = await runInTransaction(async (session) => {
    // Cleared per attempt so a retry does not re-queue the previous attempt's work.
    notifications.length = 0;

    if (!mongoose.Types.ObjectId.isValid(String(bookingId || ''))) {
      throw carpoolError(404, CARPOOL_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
    }

    const booking = await CarpoolBooking.findById(bookingId).session(session);

    if (!booking || String(booking.passengerId) !== String(userId)) {
      throw carpoolError(404, CARPOOL_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
    }

    if (![CARPOOL_BOOKING_STATUS.PENDING, CARPOOL_BOOKING_STATUS.ACCEPTED].includes(booking.status)) {
      throw carpoolError(
        409,
        CARPOOL_ERRORS.BOOKING_ALREADY_PROCESSED,
        `This booking is already ${booking.status.toLowerCase()}.`,
      );
    }

    // Only an accepted booking holds seats; releasing on a pending one would
    // credit seats that were never taken.
    await releaseSeats({ rideId: booking.rideId, seats: booking.seatsHeld, session });

    const payment = await settlement.onBookingCancelled({ booking, cancelledBy: 'passenger' });

    booking.status = CARPOOL_BOOKING_STATUS.CANCELLED;
    booking.paymentStatus = payment.paymentStatus;
    booking.cancelledAt = new Date();
    booking.cancelledBy = 'passenger';
    booking.cancellationReason = String(reason || '').trim();
    booking.isActive = false;
    booking.seatsHeld = 0;
    await booking.save({ session });

    notifications.push(['CARPOOL_BOOKING_CANCELLED', { booking }]);

    return serializeBooking(booking);
  });

  await flushNotifications(notifications);

  return result;
};

/**
 * Host cancels the whole ride (§24). Every live booking is cancelled with it and
 * the seats released, in one transaction — a half-cancelled ride would leave
 * passengers believing they still have a seat.
 */
export const cancelRide = async ({ rideId, userId, reason }) => {
  const notifications = [];

  const result = await runInTransaction(async (session) => {
    // Cleared per attempt so a retry does not re-queue the previous attempt's work.
    notifications.length = 0;

    const ride = await requireOwnedRide({ rideId, userId }, { session });

    if ([CARPOOL_RIDE_STATUS.COMPLETED, CARPOOL_RIDE_STATUS.CANCELLED].includes(ride.status)) {
      throw carpoolError(409, CARPOOL_ERRORS.RIDE_NOT_AVAILABLE, `This ride is already ${ride.status.toLowerCase()}.`);
    }

    const affected = await CarpoolBooking.find({
      rideId: ride._id,
      status: { $in: [CARPOOL_BOOKING_STATUS.PENDING, CARPOOL_BOOKING_STATUS.ACCEPTED] },
    }).session(session);

    for (const booking of affected) {
      const payment = await settlement.onBookingCancelled({ booking, ride, cancelledBy: 'driver' });

      booking.status = CARPOOL_BOOKING_STATUS.CANCELLED;
      booking.paymentStatus = payment.paymentStatus;
      booking.cancelledAt = new Date();
      booking.cancelledBy = 'driver';
      booking.cancellationReason = 'Ride cancelled by the host.';
      booking.isActive = false;
      booking.seatsHeld = 0;
      await booking.save({ session });
    }

    ride.status = CARPOOL_RIDE_STATUS.CANCELLED;
    ride.cancelledAt = new Date();
    ride.cancellationReason = String(reason || '').trim();
    ride.bookedSeats = 0;
    await ride.save({ session });


    for (const booking of affected) {
      notifications.push(['CARPOOL_RIDE_CANCELLED', { ride, booking }]);
    }

    return { rideId: String(ride._id), status: ride.status, cancelledBookings: affected.length };
  });

  await flushNotifications(notifications);

  return result;
};

export const listRideRequests = async ({ rideId, userId, status }) => {
  await requireOwnedRide({ rideId, userId });

  const filter = { rideId };

  if (status) {
    filter.status = String(status).toUpperCase();
  }

  const bookings = await CarpoolBooking.find(filter)
    .sort({ createdAt: -1 })
    .populate('passengerId', 'name profileImage');

  return bookings.map((booking) => ({
    ...serializeBooking(booking),
    passenger: serializePassenger(booking.passengerId),
  }));
};

export const listMyBookings = async ({ userId, status }) => {
  const filter = { passengerId: userId };

  if (status) {
    filter.status = String(status).toUpperCase();
  }

  const bookings = await CarpoolBooking.find(filter)
    .sort({ createdAt: -1 })
    .populate({ path: 'rideId', populate: { path: 'vehicleId' } })
    .populate('driverId', 'name profileImage');

  return bookings.map((booking) => ({
    ...serializeBooking(booking, { ride: booking.rideId }),
    host: serializePassenger(booking.driverId),
  }));
};

export const getBooking = async ({ bookingId, userId }) => {
  if (!mongoose.Types.ObjectId.isValid(String(bookingId || ''))) {
    throw carpoolError(404, CARPOOL_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
  }

  const booking = await CarpoolBooking.findById(bookingId);

  if (!booking) {
    throw carpoolError(404, CARPOOL_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
  }

  // Authorize against the raw references before populating. Populating first
  // would resolve a missing or deleted user to null and lock the other party out
  // of their own booking.
  const isPassenger = String(booking.passengerId) === String(userId);
  const isHost = String(booking.driverId) === String(userId);

  // Only the two people on this booking may read it (§43).
  if (!isPassenger && !isHost) {
    throw carpoolError(404, CARPOOL_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
  }

  const passengerRef = String(booking.passengerId);
  const hostRef = String(booking.driverId);

  await booking.populate([
    { path: 'rideId' },
    { path: 'passengerId', select: 'name profileImage' },
    { path: 'driverId', select: 'name profileImage' },
  ]);

  return {
    ...serializeBooking(booking, { ride: booking.rideId }),
    passenger: serializePassenger(booking.passengerId, passengerRef),
    host: serializePassenger(booking.driverId, hostRef),
    viewerRole: isHost ? 'host' : 'passenger',
  };
};

/**
 * Host starts the ride (§30). Accepted bookings ride with it; anything still
 * pending is declined, because there is no longer a trip to join.
 */
export const startRide = async ({ rideId, userId }) => {
  const notifications = [];
  let startedRide = null;

  const result = await runInTransaction(async (session) => {
    notifications.length = 0;

    const ride = await requireOwnedRide({ rideId, userId }, { session });

    if (![CARPOOL_RIDE_STATUS.PUBLISHED, CARPOOL_RIDE_STATUS.FULL].includes(ride.status)) {
      throw carpoolError(
        409,
        CARPOOL_ERRORS.RIDE_NOT_AVAILABLE,
        `A ${ride.status.toLowerCase()} ride cannot be started.`,
      );
    }

    const stranded = await CarpoolBooking.find({
      rideId: ride._id,
      status: CARPOOL_BOOKING_STATUS.PENDING,
    }).session(session);

    for (const booking of stranded) {
      booking.status = CARPOOL_BOOKING_STATUS.REJECTED;
      booking.rejectedAt = new Date();
      booking.isActive = false;
      booking.cancellationReason = 'The ride started before this request was answered.';
      await booking.save({ session });
      notifications.push(['CARPOOL_REQUEST_REJECTED', { ride, booking }]);
    }

    ride.status = CARPOOL_RIDE_STATUS.STARTED;
    ride.startedAt = new Date();
    await ride.save({ session });

    const riding = await CarpoolBooking.find({
      rideId: ride._id,
      status: CARPOOL_BOOKING_STATUS.ACCEPTED,
    }).session(session);

    for (const booking of riding) {
      notifications.push(['CARPOOL_RIDE_STARTED', { ride, booking }]);
    }

    startedRide = ride;

    return { rideId: String(ride._id), status: ride.status, startedAt: ride.startedAt };
  });

  await flushNotifications(notifications);
  emitCarpoolRideStatus(getSocketServer(), startedRide);

  return result;
};

/** Host completes the ride (§31). Accepted bookings become COMPLETED with it. */
export const completeRide = async ({ rideId, userId }) => {
  const notifications = [];
  let completedRide = null;

  const result = await runInTransaction(async (session) => {
    notifications.length = 0;

    const ride = await requireOwnedRide({ rideId, userId }, { session });

    if (ride.status !== CARPOOL_RIDE_STATUS.STARTED) {
      throw carpoolError(409, CARPOOL_ERRORS.RIDE_NOT_AVAILABLE, 'Only a started ride can be completed.');
    }

    const bookings = await CarpoolBooking.find({
      rideId: ride._id,
      status: CARPOOL_BOOKING_STATUS.ACCEPTED,
    }).session(session);

    const payment = await settlement.onRideCompleted({ ride, bookings });

    for (const booking of bookings) {
      booking.status = CARPOOL_BOOKING_STATUS.COMPLETED;
      booking.paymentStatus = payment.paymentStatus;
      booking.completedAt = new Date();
      // The trip is over, so the seat is no longer held and the passenger is
      // free to book this host again.
      booking.isActive = false;
      await booking.save({ session });
      notifications.push(['CARPOOL_RIDE_COMPLETED', { ride, booking }]);
    }

    ride.status = CARPOOL_RIDE_STATUS.COMPLETED;
    ride.completedAt = new Date();
    await ride.save({ session });

    // Counted here rather than on rating, because a trip happened whether or not
    // anyone leaves a review.
    await recordCompletedTrips({
      hostId: ride.driverId,
      passengerIds: bookings.map((booking) => booking.passengerId),
      session,
    });

    completedRide = ride;

    return { rideId: String(ride._id), status: ride.status, completedBookings: bookings.length };
  });

  await flushNotifications(notifications);
  // Tells anyone still watching the ride to stop tracking (§32).
  emitCarpoolRideStatus(getSocketServer(), completedRide);

  return result;
};
