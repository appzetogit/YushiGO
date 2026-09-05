import mongoose from 'mongoose';
import { CarpoolRating } from '../models/CarpoolRating.js';
import { CarpoolUserStats, averageOf } from '../models/CarpoolUserStats.js';
import { CarpoolBooking } from '../models/CarpoolBooking.js';
import { CARPOOL_BOOKING_STATUS, CARPOOL_ERRORS } from '../constants/index.js';
import { carpoolError } from './carpoolVehicleService.js';
import { runInTransaction } from './transaction.js';

export const serializeRating = (rating) => ({
  id: String(rating._id),
  rideId: String(rating.rideId),
  bookingId: String(rating.bookingId),
  ratedUserId: String(rating.ratedUserId),
  raterRole: rating.raterRole,
  rating: rating.rating,
  review: rating.review || '',
  createdAt: rating.createdAt,
});

/**
 * Reputation for one user, split by the seat they occupied.
 *
 * A good passenger and a good host are different claims, so they are reported
 * separately rather than merged into one number.
 */
export const getUserStats = async (userId) => {
  const stats = await CarpoolUserStats.findOne({ userId });

  return {
    asHost: {
      rating: averageOf(stats?.asHost),
      ratingCount: stats?.asHost?.ratingCount || 0,
      trips: stats?.asHost?.trips || 0,
    },
    asPassenger: {
      rating: averageOf(stats?.asPassenger),
      ratingCount: stats?.asPassenger?.ratingCount || 0,
      trips: stats?.asPassenger?.trips || 0,
    },
  };
};

/** Batch variant, so a page of search results costs one query rather than N. */
export const getStatsForUsers = async (userIds = []) => {
  // Non-ids are dropped rather than passed through: a ride whose host account
  // was deleted resolves to null, and casting that would fail the whole search
  // instead of returning the other rides.
  const ids = [...new Set(
    userIds
      .map((id) => String(id?._id || id || ''))
      .filter((id) => mongoose.Types.ObjectId.isValid(id)),
  )];

  if (!ids.length) {
    return new Map();
  }

  const rows = await CarpoolUserStats.find({ userId: { $in: ids } });

  return new Map(rows.map((row) => [String(row.userId), {
    rating: averageOf(row.asHost),
    ratingCount: row.asHost?.ratingCount || 0,
    trips: row.asHost?.trips || 0,
  }]));
};

export const createRating = async ({ userId, payload }) => {
  const bookingId = String(payload?.booking_id ?? payload?.bookingId ?? '');
  const rating = Number(payload?.rating);

  if (!mongoose.Types.ObjectId.isValid(bookingId)) {
    throw carpoolError(404, CARPOOL_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
  }

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw carpoolError(422, CARPOOL_ERRORS.RATING_NOT_ALLOWED, 'rating must be a whole number from 1 to 5.');
  }

  return runInTransaction(async (session) => {
    const booking = await CarpoolBooking.findById(bookingId).session(session);

    if (!booking) {
      throw carpoolError(404, CARPOOL_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
    }

    const isHost = String(booking.driverId) === String(userId);
    const isPassenger = String(booking.passengerId) === String(userId);

    // Only the two people who shared the trip may rate it (§35).
    if (!isHost && !isPassenger) {
      throw carpoolError(404, CARPOOL_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
    }

    if (booking.status !== CARPOOL_BOOKING_STATUS.COMPLETED) {
      throw carpoolError(
        409,
        CARPOOL_ERRORS.RATING_NOT_ALLOWED,
        'You can rate a trip once it is completed.',
      );
    }

    // The counterparty is derived from the booking, never taken from the
    // request: a rated_user_id in the body could otherwise target anyone.
    const ratedUserId = isHost ? booking.passengerId : booking.driverId;
    const raterRole = isHost ? 'host' : 'passenger';

    if (String(ratedUserId) === String(userId)) {
      throw carpoolError(422, CARPOOL_ERRORS.RATING_NOT_ALLOWED, 'You cannot rate yourself.');
    }

    let created;

    try {
      [created] = await CarpoolRating.create([{
        rideId: booking.rideId,
        bookingId: booking._id,
        raterId: userId,
        ratedUserId,
        raterRole,
        rating,
        review: String(payload?.review || '').trim(),
      }], { session });
    } catch (error) {
      if (error?.code === 11000) {
        throw carpoolError(409, CARPOOL_ERRORS.DUPLICATE_RATING, 'You have already rated this trip.');
      }

      throw error;
    }

    // A host rating a passenger updates that passenger's asPassenger figures,
    // and vice versa — the bucket follows who was rated, not who rated.
    const bucket = raterRole === 'host' ? 'asPassenger' : 'asHost';

    await CarpoolUserStats.findOneAndUpdate(
      { userId: ratedUserId },
      { $inc: { [`${bucket}.ratingSum`]: rating, [`${bucket}.ratingCount`]: 1 } },
      { upsert: true, session },
    );

    return serializeRating(created);
  });
};

/**
 * Record a completed trip against both parties.
 *
 * Trip counts are separate from ratings because a trip counts whether or not
 * anyone leaves a review.
 */
export const recordCompletedTrips = async ({ hostId, passengerIds = [], session = null }) => {
  const options = session ? { upsert: true, session } : { upsert: true };

  if (hostId) {
    await CarpoolUserStats.findOneAndUpdate(
      { userId: hostId },
      { $inc: { 'asHost.trips': 1 } },
      options,
    );
  }

  for (const passengerId of passengerIds) {
    await CarpoolUserStats.findOneAndUpdate(
      { userId: passengerId },
      { $inc: { 'asPassenger.trips': 1 } },
      options,
    );
  }
};

export const listRatingsForUser = async ({ userId, role }) => {
  const filter = { ratedUserId: userId };

  if (role === 'host') {
    // Ratings a passenger left about them as a host.
    filter.raterRole = 'passenger';
  } else if (role === 'passenger') {
    filter.raterRole = 'host';
  }

  const ratings = await CarpoolRating.find(filter).sort({ createdAt: -1 }).limit(50);

  return ratings.map(serializeRating);
};

/** Which bookings the caller can still rate — drives the "rate your trip" prompt. */
export const listRatableBookings = async ({ userId }) => {
  const bookings = await CarpoolBooking.find({
    status: CARPOOL_BOOKING_STATUS.COMPLETED,
    $or: [{ passengerId: userId }, { driverId: userId }],
  }).sort({ completedAt: -1 }).limit(50);

  if (!bookings.length) {
    return [];
  }

  const rated = await CarpoolRating.find({
    raterId: userId,
    bookingId: { $in: bookings.map((booking) => booking._id) },
  }).select('bookingId');

  const alreadyRated = new Set(rated.map((row) => String(row.bookingId)));

  return bookings
    .filter((booking) => !alreadyRated.has(String(booking._id)))
    .map((booking) => ({
      bookingId: String(booking._id),
      rideId: String(booking.rideId),
      role: String(booking.driverId) === String(userId) ? 'host' : 'passenger',
      completedAt: booking.completedAt,
    }));
};
