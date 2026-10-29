import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { normalizePoint, toPoint } from '../../../../utils/geo.js';
import {
  emitToDriver,
  getDriverRoom,
  getSocketServer,
  markDriverRejectedFromDispatch,
  notifyRideAccepted,
} from '../../services/dispatchService.js';
import { acceptRideAssignment, getRideRoom } from '../../services/rideService.js';
import { SOCKET_EVENTS } from '../../socket/events.js';
import { Driver } from '../models/Driver.js';
import { touchDriverPresence } from '../services/driverPresenceService.js';

/**
 * REST twins of the socket acceptRide / rejectRide events, for the ride-request
 * overlay, which may have no socket open. Same service calls, same events to the
 * rider, so either path works and the first accept still wins.
 */

const readRideId = (req) => {
  const rideId = String(req.params.rideId || '').trim();
  if (!mongoose.Types.ObjectId.isValid(rideId)) {
    throw new ApiError(400, 'rideId is invalid');
  }
  return rideId;
};

export const acceptRideOffer = async (req, res) => {
  const rideId = readRideId(req);
  const driverId = req.auth.sub;

  const ride = await acceptRideAssignment({ rideId, driverId });
  touchDriverPresence(driverId).catch(() => {});

  // Any socket the driver does have open follows the ride, as the socket path does.
  getSocketServer()?.in(getDriverRoom(driverId)).socketsJoin(getRideRoom(ride._id));
  await notifyRideAccepted(ride);

  const acceptedPayload = {
    rideId: String(ride._id),
    room: getRideRoom(ride._id),
    status: ride.status,
    liveStatus: ride.liveStatus,
    acceptedAt: ride.acceptedAt,
  };
  emitToDriver(driverId, 'rideAccepted', acceptedPayload);
  emitToDriver(driverId, SOCKET_EVENTS.RIDE_STATE, acceptedPayload);

  res.json({ success: true, data: acceptedPayload });
};

export const rejectRideOffer = async (req, res) => {
  const rideId = readRideId(req);
  const driverId = req.auth.sub;

  await markDriverRejectedFromDispatch(rideId, driverId);
  touchDriverPresence(driverId).catch(() => {});
  getSocketServer()?.to(getRideRoom(rideId)).emit('driverRejectedRide', { rideId, driverId });

  res.json({ success: true, data: { rideId, rejected: true } });
};

/**
 * Keeps an online driver online while the app has no socket (background, flaky
 * network). Call it every minute or two; an optional location refreshes the map.
 */
export const driverHeartbeat = async (req, res) => {
  const driverId = req.auth.sub;
  const extra = {};
  if (req.body?.location) {
    extra.location = toPoint(normalizePoint(req.body.location, 'location'), 'location');
  }

  await touchDriverPresence(driverId, extra);
  const driver = await Driver.findById(driverId).select('isOnline isOnRide lastSeenAt').lean();
  if (!driver) {
    throw new ApiError(404, 'Driver not found');
  }

  res.json({
    success: true,
    data: { isOnline: Boolean(driver.isOnline), isOnRide: Boolean(driver.isOnRide), lastSeenAt: driver.lastSeenAt },
  });
};
