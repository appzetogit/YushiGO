import { CarpoolRide } from '../models/CarpoolRide.js';
import { CarpoolBooking } from '../models/CarpoolBooking.js';
import { CARPOOL_BOOKING_STATUS, CARPOOL_RIDE_STATUS } from '../constants/index.js';

/**
 * Carpool live tracking (§32).
 *
 * Runs on the platform's existing Socket.IO server, its JWT handshake and its
 * room model — no second tracking stack. Only the room naming and the
 * authorization rules are carpool-specific, because a carpool host is an
 * ordinary user rather than an onboarded driver, so the taxi handler's
 * driver-role checks do not apply.
 */
export const getCarpoolRideRoom = (rideId) => `carpool_ride:${rideId}`;

/** Tracking is live only while the trip is actually running (§32). */
const TRACKABLE_STATUSES = [CARPOOL_RIDE_STATUS.STARTED];

/**
 * Everyone entitled to watch a carpool ride: the host, and passengers holding a
 * confirmed seat. A pending request is not enough — an unanswered request must
 * not reveal where someone is driving.
 */
const resolveParticipant = async ({ rideId, userId }) => {
  const ride = await CarpoolRide.findById(rideId).select('driverId status');

  if (!ride) {
    return null;
  }

  if (String(ride.driverId) === String(userId)) {
    return { ride, role: 'host' };
  }

  const booking = await CarpoolBooking.findOne({
    rideId: ride._id,
    passengerId: userId,
    status: CARPOOL_BOOKING_STATUS.ACCEPTED,
  }).select('_id');

  return booking ? { ride, role: 'passenger' } : null;
};

export const registerCarpoolSocketHandlers = ({ io, socket, onAsync }) => {
  const identity = socket.auth || {};

  socket.on(
    'carpool:join',
    onAsync(socket, async ({ rideId }) => {
      if (!rideId) {
        return;
      }

      const participant = await resolveParticipant({ rideId, userId: identity.sub });

      if (!participant) {
        socket.emit('carpool:error', { rideId: String(rideId), message: 'Not a participant on this ride.' });
        return;
      }

      socket.join(getCarpoolRideRoom(rideId));
      socket.emit('carpool:joined', {
        rideId: String(rideId),
        room: getCarpoolRideRoom(rideId),
        role: participant.role,
        status: participant.ride.status,
      });
    }),
  );

  socket.on(
    'carpool:leave',
    onAsync(socket, async ({ rideId }) => {
      if (rideId) {
        socket.leave(getCarpoolRideRoom(rideId));
      }
    }),
  );

  socket.on(
    'carpool:location:update',
    onAsync(socket, async ({ rideId, latitude, longitude, heading, speed }) => {
      if (!rideId) {
        return;
      }

      const lat = Number(latitude);
      const lng = Number(longitude);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)
        || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        socket.emit('carpool:error', { rideId: String(rideId), message: 'Invalid coordinates.' });
        return;
      }

      const ride = await CarpoolRide.findById(rideId).select('driverId status');

      // Only the host of this specific ride may push its location. Without this
      // any authenticated user could inject a position into someone's trip.
      if (!ride || String(ride.driverId) !== String(identity.sub)) {
        socket.emit('carpool:error', { rideId: String(rideId), message: 'You are not driving this ride.' });
        return;
      }

      if (!TRACKABLE_STATUSES.includes(ride.status)) {
        socket.emit('carpool:error', { rideId: String(rideId), message: 'This ride is not currently trackable.' });
        return;
      }

      // Relayed, not stored: a carpool position is only useful while the trip is
      // running, and persisting every ping would add write load for data nobody
      // reads afterwards. Passengers get it live; history stays out of the
      // database until there is a reason for it.
      io.to(getCarpoolRideRoom(rideId)).emit('carpool:location:updated', {
        rideId: String(rideId),
        latitude: lat,
        longitude: lng,
        heading: Number.isFinite(Number(heading)) ? Number(heading) : null,
        speed: Number.isFinite(Number(speed)) ? Number(speed) : null,
        timestamp: new Date().toISOString(),
      });
    }),
  );
};

/** Broadcast a status change to everyone watching the ride. */
export const emitCarpoolRideStatus = (io, ride) => {
  if (!io || !ride) {
    return;
  }

  io.to(getCarpoolRideRoom(ride._id)).emit('carpool:status:updated', {
    rideId: String(ride._id),
    status: ride.status,
    startedAt: ride.startedAt || null,
    completedAt: ride.completedAt || null,
  });
};
