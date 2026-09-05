import { CarpoolRide } from '../models/CarpoolRide.js';
import { CarpoolBooking } from '../models/CarpoolBooking.js';
import { CARPOOL_BOOKING_STATUS, CARPOOL_RIDE_STATUS } from '../constants/index.js';
import { serializeRideForOwner } from './carpoolRideService.js';
import { serializeBooking } from './carpoolBookingService.js';
import { getUserStats } from './carpoolRatingService.js';

const UPCOMING_RIDE_STATUSES = [CARPOOL_RIDE_STATUS.PUBLISHED, CARPOOL_RIDE_STATUS.FULL, CARPOOL_RIDE_STATUS.STARTED];
const UPCOMING_BOOKING_STATUSES = [CARPOOL_BOOKING_STATUS.PENDING, CARPOOL_BOOKING_STATUS.ACCEPTED];

const rideFilterForStatus = (status) => {
  switch (String(status || '').toLowerCase()) {
    case 'upcoming':
      return { status: { $in: UPCOMING_RIDE_STATUSES } };
    case 'completed':
      return { status: CARPOOL_RIDE_STATUS.COMPLETED };
    case 'cancelled':
      return { status: { $in: [CARPOOL_RIDE_STATUS.CANCELLED, CARPOOL_RIDE_STATUS.EXPIRED] } };
    default:
      return {};
  }
};

const bookingFilterForStatus = (status) => {
  switch (String(status || '').toLowerCase()) {
    case 'upcoming':
      return { status: { $in: UPCOMING_BOOKING_STATUSES } };
    case 'completed':
      return { status: CARPOOL_BOOKING_STATUS.COMPLETED };
    case 'cancelled':
      return { status: { $in: [CARPOOL_BOOKING_STATUS.CANCELLED, CARPOOL_BOOKING_STATUS.REJECTED] } };
    default:
      return {};
  }
};

/**
 * Both sides of a user's carpool life in one call (§27).
 *
 * The same account hosts some trips and rides on others, so these are two lists
 * over different collections rather than one list with a role column.
 */
export const getMyTrips = async ({ userId, type = 'all', status }) => {
  const wantsOffered = type === 'all' || type === 'offered';
  const wantsPassenger = type === 'all' || type === 'passenger';

  const offeredRides = wantsOffered
    ? await CarpoolRide.find({ driverId: userId, ...rideFilterForStatus(status) })
      .sort({ departureAt: -1 })
      .limit(100)
      .populate('vehicleId')
    : [];

  const passengerBookings = wantsPassenger
    ? await CarpoolBooking.find({ passengerId: userId, ...bookingFilterForStatus(status) })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate({ path: 'rideId', populate: { path: 'vehicleId' } })
    : [];

  return {
    offered_rides: offeredRides.map((ride) => serializeRideForOwner(ride, { vehicle: ride.vehicleId })),
    passenger_trips: passengerBookings.map((booking) => serializeBooking(booking, { ride: booking.rideId })),
  };
};

/** Carpool home summary (§11.1). */
export const getCarpoolHome = async ({ userId }) => {
  const [
    offeredCount,
    upcomingOffered,
    upcomingBooked,
    completedOffered,
    completedBooked,
    pendingRequests,
    recentRides,
    stats,
  ] = await Promise.all([
    CarpoolRide.countDocuments({ driverId: userId, status: { $in: UPCOMING_RIDE_STATUSES } }),
    CarpoolRide.countDocuments({ driverId: userId, status: { $in: UPCOMING_RIDE_STATUSES } }),
    CarpoolBooking.countDocuments({ passengerId: userId, status: { $in: UPCOMING_BOOKING_STATUSES } }),
    CarpoolRide.countDocuments({ driverId: userId, status: CARPOOL_RIDE_STATUS.COMPLETED }),
    CarpoolBooking.countDocuments({ passengerId: userId, status: CARPOOL_BOOKING_STATUS.COMPLETED }),
    // Requests waiting on this user as a host — the one number that needs action.
    CarpoolBooking.countDocuments({ driverId: userId, status: CARPOOL_BOOKING_STATUS.PENDING }),
    CarpoolRide.find({ driverId: userId })
      .sort({ departureAt: -1 })
      .limit(5)
      .populate('vehicleId'),
    getUserStats(userId),
  ]);

  return {
    upcoming_count: upcomingOffered + upcomingBooked,
    offered_count: offeredCount,
    completed_count: completedOffered + completedBooked,
    pending_requests_count: pendingRequests,
    stats,
    recent_rides: recentRides.map((ride) => serializeRideForOwner(ride, { vehicle: ride.vehicleId })),
  };
};
