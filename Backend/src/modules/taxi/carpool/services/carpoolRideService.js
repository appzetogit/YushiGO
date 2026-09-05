import mongoose from 'mongoose';
import { CarpoolRide } from '../models/CarpoolRide.js';
import {
  CARPOOL_ERRORS,
  CARPOOL_SEARCHABLE_STATUSES,
  carpoolConfig,
} from '../constants/index.js';
import {
  assertVehicleEligibleToPublish,
  carpoolError,
  requireOwnedVehicle,
  serializeVehicle,
  serializeVehiclePublic,
} from './carpoolVehicleService.js';
import {
  buildRouteCoordinates,
  evaluateRouteMatch,
  rankMatches,
} from './routeMatching.js';
import { getStatsForUsers } from './carpoolRatingService.js';

const parsePlace = (value, field) => {
  const name = String(value?.name || '').trim();
  const latitude = Number(value?.lat ?? value?.latitude);
  const longitude = Number(value?.lng ?? value?.longitude);

  if (!name) {
    throw carpoolError(422, CARPOOL_ERRORS.LOCATION_INVALID, `${field}.name is required.`);
  }

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw carpoolError(422, CARPOOL_ERRORS.LOCATION_INVALID, `${field}.lat must be between -90 and 90.`);
  }

  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw carpoolError(422, CARPOOL_ERRORS.LOCATION_INVALID, `${field}.lng must be between -180 and 180.`);
  }

  return { name, latitude, longitude };
};

/**
 * Combine the host's date and time into a UTC instant.
 *
 * The pair is also stored verbatim for display: recomputing local wall-clock
 * time from an instant would show a different departure to a passenger in
 * another timezone than the host typed.
 */
const parseDeparture = ({ date, departureTime }) => {
  const rawDate = String(date || '').trim();
  const rawTime = String(departureTime || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    throw carpoolError(422, CARPOOL_ERRORS.INVALID_ROUTE, 'date must be formatted YYYY-MM-DD.');
  }

  if (!/^\d{2}:\d{2}$/.test(rawTime)) {
    throw carpoolError(422, CARPOOL_ERRORS.INVALID_ROUTE, 'departure_time must be formatted HH:mm.');
  }

  const departureAt = new Date(`${rawDate}T${rawTime}:00.000Z`);

  if (Number.isNaN(departureAt.getTime())) {
    throw carpoolError(422, CARPOOL_ERRORS.INVALID_ROUTE, 'date and departure_time do not form a valid time.');
  }

  if (departureAt.getTime() <= Date.now()) {
    throw carpoolError(422, CARPOOL_ERRORS.INVALID_ROUTE, 'Departure must be in the future.');
  }

  return { departureAt, date: rawDate, departureTime: rawTime };
};

const parseStops = (stops) => {
  if (!Array.isArray(stops) || stops.length === 0) {
    return [];
  }

  return stops
    .map((stop, index) => {
      const place = parsePlace(stop, `stops[${index}]`);
      const order = Number(stop?.order ?? stop?.stopOrder ?? index + 1);

      if (!Number.isFinite(order)) {
        throw carpoolError(422, CARPOOL_ERRORS.INVALID_ROUTE, `stops[${index}].order must be a number.`);
      }

      return { ...place, stopOrder: order, estimatedTime: String(stop?.estimated_time || '').trim() };
    })
    .sort((a, b) => a.stopOrder - b.stopOrder);
};

/** Verification badges only — never the documents behind them (§42). */
const serializeHost = (user, stats = {}) => ({
  id: String(user?._id || user),
  name: user?.name || '',
  profileImage: user?.profileImage || '',
  rating: stats.rating ?? null,
  ratingCount: stats.ratingCount ?? 0,
  totalTrips: stats.trips ?? 0,
  phoneVerified: Boolean(user?.phoneVerified ?? user?.isPhoneVerified ?? false),
  profileVerified: Boolean(user?.profileVerified ?? false),
});

export const serializeRideForOwner = (ride, { vehicle } = {}) => ({
  rideId: String(ride._id),
  status: ride.status,
  origin: ride.origin,
  destination: ride.destination,
  pickup: ride.pickup,
  drop: ride.drop,
  stops: (ride.stops || []).map((stop) => ({
    id: String(stop._id),
    order: stop.stopOrder,
    name: stop.name,
    latitude: stop.latitude,
    longitude: stop.longitude,
    estimatedTime: stop.estimatedTime || '',
  })),
  date: ride.date,
  departureTime: ride.departureTime,
  departureAt: ride.departureAt,
  estimatedArrivalTime: ride.estimatedArrivalTime || '',
  offeredSeats: ride.offeredSeats,
  bookedSeats: ride.bookedSeats,
  availableSeats: Math.max(0, ride.offeredSeats - ride.bookedSeats),
  pricePerSeat: ride.pricePerSeat,
  preferences: ride.preferences,
  notes: ride.notes || '',
  vehicle: vehicle ? serializeVehicle(vehicle) : undefined,
  startedAt: ride.startedAt,
  completedAt: ride.completedAt,
  cancelledAt: ride.cancelledAt,
  createdAt: ride.createdAt,
});

export const serializeRidePublic = (ride, { match = null, hostStats = null } = {}) => ({
  rideId: String(ride._id),
  status: ride.status,
  host: ride.driverId && typeof ride.driverId === 'object'
    ? serializeHost(ride.driverId, hostStats || {})
    : null,
  route: { origin: ride.origin?.name || '', destination: ride.destination?.name || '' },
  pickup: ride.pickup,
  drop: ride.drop,
  stops: (ride.stops || []).map((stop) => ({
    order: stop.stopOrder,
    name: stop.name,
    latitude: stop.latitude,
    longitude: stop.longitude,
  })),
  date: ride.date,
  departureTime: ride.departureTime,
  departureAt: ride.departureAt,
  vehicle: ride.vehicleId && typeof ride.vehicleId === 'object' ? serializeVehiclePublic(ride.vehicleId) : null,
  availableSeats: Math.max(0, ride.offeredSeats - ride.bookedSeats),
  pricePerSeat: ride.pricePerSeat,
  preferences: ride.preferences,
  notes: ride.notes || '',
  // Present on search results so the app can show why a ride matched (§46).
  ...(match ? { match } : {}),
});

export const createRide = async ({ userId, payload }) => {
  const config = carpoolConfig();

  const vehicle = await requireOwnedVehicle({ vehicleId: payload?.vehicle_id ?? payload?.vehicleId, userId });
  assertVehicleEligibleToPublish(vehicle);

  const origin = parsePlace(payload?.origin, 'origin');
  const destination = parsePlace(payload?.destination, 'destination');
  const pickup = parsePlace(payload?.pickup ?? payload?.origin, 'pickup');
  const drop = parsePlace(payload?.drop ?? payload?.destination, 'drop');
  const stops = parseStops(payload?.stops);
  const { departureAt, date, departureTime } = parseDeparture({
    date: payload?.date,
    departureTime: payload?.departure_time ?? payload?.departureTime,
  });

  const offeredSeats = Number(payload?.available_seats ?? payload?.availableSeats);
  const pricePerSeat = Number(payload?.price_per_seat ?? payload?.pricePerSeat);

  if (!Number.isInteger(offeredSeats) || offeredSeats < 1 || offeredSeats > config.maxSeatsPerRide) {
    throw carpoolError(
      422,
      CARPOOL_ERRORS.INVALID_ROUTE,
      `available_seats must be a whole number between 1 and ${config.maxSeatsPerRide}.`,
    );
  }

  // Seats offered cannot exceed what the car holds — the vehicle record is the
  // authority, not the number the client sent.
  if (offeredSeats > vehicle.seatCapacity) {
    throw carpoolError(
      422,
      CARPOOL_ERRORS.INVALID_VEHICLE,
      `This vehicle seats ${vehicle.seatCapacity} passengers.`,
    );
  }

  if (!Number.isFinite(pricePerSeat) || pricePerSeat < 0 || pricePerSeat > config.maxPricePerSeat) {
    throw carpoolError(
      422,
      CARPOOL_ERRORS.INVALID_ROUTE,
      `price_per_seat must be between 0 and ${config.maxPricePerSeat}.`,
    );
  }

  const routeCoordinates = buildRouteCoordinates({ origin, stops, destination });
  const preferences = payload?.preferences || {};

  const ride = await CarpoolRide.create({
    driverId: userId,
    vehicleId: vehicle._id,
    origin,
    destination,
    pickup,
    drop,
    stops,
    routePath: { type: 'LineString', coordinates: routeCoordinates },
    departureAt,
    date,
    departureTime,
    estimatedArrivalTime: String(payload?.estimated_arrival_time || payload?.estimatedArrivalTime || '').trim(),
    offeredSeats,
    pricePerSeat,
    preferences: {
      ac: Boolean(preferences.ac),
      smokingAllowed: Boolean(preferences.smoking_allowed ?? preferences.smokingAllowed),
      petsAllowed: Boolean(preferences.pets_allowed ?? preferences.petsAllowed),
      musicAllowed: preferences.music_allowed ?? preferences.musicAllowed ?? true,
      luggageAllowed: preferences.luggage_allowed ?? preferences.luggageAllowed ?? true,
      pickupFlexibilityMinutes: Number(
        preferences.pickup_flexibility_minutes ?? preferences.pickupFlexibilityMinutes ?? 0,
      ) || 0,
    },
    notes: String(payload?.notes || '').trim(),
  });

  return serializeRideForOwner(ride, { vehicle });
};

export const getRideById = async ({ rideId, userId }) => {
  if (!mongoose.Types.ObjectId.isValid(String(rideId || ''))) {
    throw carpoolError(404, CARPOOL_ERRORS.RIDE_NOT_FOUND, 'Ride not found.');
  }

  const ride = await CarpoolRide.findById(rideId)
    .populate('driverId', 'name profileImage phoneVerified profileVerified')
    .populate('vehicleId');

  if (!ride) {
    throw carpoolError(404, CARPOOL_ERRORS.RIDE_NOT_FOUND, 'Ride not found.');
  }

  // The host sees their own ride in full; everyone else sees the public view.
  if (String(ride.driverId?._id || ride.driverId) === String(userId)) {
    return { ...serializeRideForOwner(ride, { vehicle: ride.vehicleId }), isOwner: true };
  }

  const stats = await getStatsForUsers([ride.driverId?._id || ride.driverId]);

  return {
    ...serializeRidePublic(ride, {
      hostStats: stats.get(String(ride.driverId?._id || ride.driverId)) || null,
    }),
    isOwner: false,
  };
};

/**
 * Search (§13/§14).
 *
 * The 2dsphere index narrows to rides whose corridor passes near the pickup;
 * the ordering and drop rules are then applied to that candidate set.
 */
export const searchRides = async ({ userId, query }) => {
  const config = carpoolConfig();

  const pickupPoint = [
    Number(query?.from_lng ?? query?.fromLng),
    Number(query?.from_lat ?? query?.fromLat),
  ];
  const dropPoint = [
    Number(query?.to_lng ?? query?.toLng),
    Number(query?.to_lat ?? query?.toLat),
  ];

  if (!pickupPoint.every(Number.isFinite)) {
    throw carpoolError(422, CARPOOL_ERRORS.INVALID_PICKUP, 'from_lat and from_lng are required.');
  }

  if (!dropPoint.every(Number.isFinite)) {
    throw carpoolError(422, CARPOOL_ERRORS.INVALID_DROP, 'to_lat and to_lng are required.');
  }

  const seatsWanted = Math.max(1, Number(query?.passengers) || 1);
  const pickupToleranceKm = Number(query?.pickup_tolerance_km) > 0
    ? Number(query.pickup_tolerance_km)
    : config.pickupRouteToleranceKm;
  const dropToleranceKm = Number(query?.drop_tolerance_km) > 0
    ? Number(query.drop_tolerance_km)
    : config.dropRouteToleranceKm;

  const filter = {
    status: { $in: CARPOOL_SEARCHABLE_STATUSES },
    // Never surface a ride to its own host.
    driverId: { $ne: userId },
    departureAt: { $gt: new Date() },
    routePath: {
      $near: {
        $geometry: { type: 'Point', coordinates: pickupPoint },
        $maxDistance: pickupToleranceKm * 1000,
      },
    },
  };

  if (query?.date) {
    filter.date = String(query.date).trim();
  }

  const candidates = await CarpoolRide.find(filter)
    .limit(config.searchLimit)
    .populate('driverId', 'name profileImage phoneVerified profileVerified')
    .populate('vehicleId');

  const matched = [];

  for (const ride of candidates) {
    if ((ride.offeredSeats - ride.bookedSeats) < seatsWanted) {
      continue;
    }

    const match = evaluateRouteMatch({
      routeCoordinates: ride.routePath?.coordinates || [],
      pickupPoint,
      dropPoint,
      pickupToleranceKm,
      dropToleranceKm,
    });

    if (match) {
      matched.push({ ride, match });
    }
  }

  const ranked = rankMatches(matched);
  const statsByHost = await getStatsForUsers(ranked.map(({ ride }) => ride.driverId?._id || ride.driverId));

  return ranked.map(({ ride, match }) => serializeRidePublic(ride, {
    match,
    hostStats: statsByHost.get(String(ride.driverId?._id || ride.driverId)) || null,
  }));
};

export const requireOwnedRide = async ({ rideId, userId }, { session = null } = {}) => {
  if (!mongoose.Types.ObjectId.isValid(String(rideId || ''))) {
    throw carpoolError(404, CARPOOL_ERRORS.RIDE_NOT_FOUND, 'Ride not found.');
  }

  const query = CarpoolRide.findById(rideId);

  if (session) {
    query.session(session);
  }

  const ride = await query;

  if (!ride) {
    throw carpoolError(404, CARPOOL_ERRORS.RIDE_NOT_FOUND, 'Ride not found.');
  }

  if (String(ride.driverId) !== String(userId)) {
    throw carpoolError(403, CARPOOL_ERRORS.UNAUTHORIZED_RIDE_ACCESS, 'You do not own this ride.');
  }

  return ride;
};

export const listMyOfferedRides = async ({ userId, status }) => {
  const filter = { driverId: userId };

  if (status) {
    filter.status = String(status).toUpperCase();
  }

  const rides = await CarpoolRide.find(filter).sort({ departureAt: -1 }).populate('vehicleId');

  return rides.map((ride) => serializeRideForOwner(ride, { vehicle: ride.vehicleId }));
};
