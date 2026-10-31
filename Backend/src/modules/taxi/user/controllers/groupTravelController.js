import mongoose from 'mongoose';
import { BusService, BUS_VEHICLE_KINDS } from '../../admin/models/BusService.js';
import { BusSeatHold } from '../models/BusSeatHold.js';
import { Vehicle } from '../../admin/models/Vehicle.js';
import { SetPrice } from '../../admin/models/SetPrice.js';
import { ApiError } from '../../../../utils/ApiError.js';
import {
  buildBusCityRegex,
  cleanupExpiredBusSeatHolds,
  ensureBusServiceEnabled,
  flattenBusBlueprintSeats,
  isScheduleAvailableOnDate,
  normalizeBusTravelDate,
  serializeBusSearchResult,
} from './userController.js';

const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees) => (Number(degrees || 0) * Math.PI) / 180;

const haversineKm = (lat1, lon1, lat2, lon2) => {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const toCleanString = (value) => String(value ?? '').trim();

const readCoords = (point = {}) => {
  const lat = Number(point?.latitude ?? point?.lat);
  const lng = Number(point?.longitude ?? point?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) ? { lat, lng } : null;
};

const parseVehicleKinds = (value) =>
  toCleanString(value)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => BUS_VEHICLE_KINDS.includes(item));

// Matches a city on the route ends or on any boarding/drop stop.
const cityMatch = (city, endField) => {
  const regex = buildBusCityRegex(city);
  return { $or: [{ [`route.${endField}`]: regex }, { 'route.stops.city': regex }] };
};

const countReservedSeats = async (busIds, travelDate) => {
  if (busIds.length === 0) return new Map();
  const holds = await BusSeatHold.find({
    busServiceId: { $in: busIds },
    travelDate,
    status: { $in: ['held', 'booked'] },
  })
    .select('busServiceId scheduleId')
    .lean();

  const counts = new Map();
  holds.forEach((hold) => {
    const key = `${String(hold.busServiceId)}:${String(hold.scheduleId)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
};

const countBookableSeats = (busService) =>
  flattenBusBlueprintSeats(busService.blueprint).filter(
    (seat) => String(seat.status || 'available') !== 'blocked',
  ).length;

/**
 * GET /schedules?origin=&destination=&date=&vehicleKind=urbania,traveller
 * Published seat-based trips (Group & Large Vehicles and buses) running on the date.
 * origin/destination are optional so the timetable can be browsed without a route.
 */
export const getSchedules = async (req, res) => {
  await ensureBusServiceEnabled();
  await cleanupExpiredBusSeatHolds();

  const origin = toCleanString(req.query?.origin || req.query?.fromCity || req.query?.from);
  const destination = toCleanString(req.query?.destination || req.query?.toCity || req.query?.to);
  const travelDate = normalizeBusTravelDate(req.query?.date || req.query?.travelDate);
  const vehicleKinds = parseVehicleKinds(req.query?.vehicleKind || req.query?.vehicleKinds);

  const conditions = [{ status: 'active' }];
  if (vehicleKinds.length > 0) {
    // Services created before vehicleKind existed have no value and are regular buses.
    const kinds = vehicleKinds.includes('bus') ? [...vehicleKinds, null] : vehicleKinds;
    conditions.push({ vehicleKind: { $in: kinds } });
  }
  if (origin) conditions.push(cityMatch(origin, 'originCity'));
  if (destination) conditions.push(cityMatch(destination, 'destinationCity'));

  const busServices = await BusService.find({ $and: conditions }).lean();
  const reserved = await countReservedSeats(busServices.map((item) => item._id), travelDate);

  const schedules = busServices
    .flatMap((busService) => {
      const totalSeats = countBookableSeats(busService);
      return (Array.isArray(busService.schedules) ? busService.schedules : [])
        .filter((schedule) => isScheduleAvailableOnDate(schedule, travelDate))
        .map((schedule) => {
          const reservedSeats = reserved.get(`${String(busService._id)}:${String(schedule.id)}`) || 0;
          return {
            ...serializeBusSearchResult({
              busService,
              schedule,
              travelDate,
              availableSeats: totalSeats - reservedSeats,
            }),
            totalSeats,
            scheduleLabel: schedule.label || '',
          };
        });
    })
    .sort((a, b) => String(a.departure).localeCompare(String(b.departure)));

  res.json({
    success: true,
    data: {
      travelDate,
      schedules,
      results: schedules,
    },
  });
};

/**
 * GET /schedules/:id/availability?scheduleId=&date=
 * :id is the bus service id, or the composite "<busServiceId>:<scheduleId>:<date>" search id.
 */
export const getScheduleAvailability = async (req, res) => {
  await ensureBusServiceEnabled();
  await cleanupExpiredBusSeatHolds();

  const [rawId, idScheduleId, idDate] = toCleanString(req.params?.id).split(':');
  const scheduleId = toCleanString(req.query?.scheduleId) || toCleanString(idScheduleId);
  const travelDate = normalizeBusTravelDate(req.query?.date || req.query?.travelDate || idDate);

  if (!mongoose.Types.ObjectId.isValid(rawId)) {
    throw new ApiError(400, 'A valid bus service id is required');
  }
  if (!scheduleId) {
    throw new ApiError(400, 'scheduleId is required');
  }

  const busService = await BusService.findById(rawId).lean();
  if (!busService || busService.status !== 'active') {
    throw new ApiError(404, 'Service not found');
  }

  const schedule = (busService.schedules || []).find((item) => String(item.id) === scheduleId);
  if (!isScheduleAvailableOnDate(schedule, travelDate)) {
    throw new ApiError(404, 'This trip does not run on the selected date');
  }

  const holds = await BusSeatHold.find({
    busServiceId: busService._id,
    scheduleId,
    travelDate,
    status: { $in: ['held', 'booked'] },
  })
    .select('seatId')
    .lean();
  const reservedSeatIds = new Set(holds.map((hold) => String(hold.seatId)));

  const mapDeck = (deckRows = []) =>
    deckRows.map((row) =>
      (Array.isArray(row) ? row : []).map((cell) => {
        if (!cell || cell.kind !== 'seat') return cell;
        const booked = String(cell.status || 'available') === 'blocked' || reservedSeatIds.has(String(cell.id));
        return { ...cell, status: booked ? 'booked' : 'available' };
      }),
    );

  const decks = {
    lowerDeck: mapDeck(busService.blueprint?.lowerDeck || []),
    upperDeck: mapDeck(busService.blueprint?.upperDeck || []),
  };
  const seats = flattenBusBlueprintSeats(decks).map((cell) => ({
    seatId: String(cell.id),
    label: cell.label || String(cell.id),
    variant: cell.variant || 'seat',
    status: cell.status,
  }));
  const bookedSeats = seats.filter((seat) => seat.status === 'booked').length;

  res.json({
    success: true,
    data: {
      busServiceId: String(busService._id),
      scheduleId,
      travelDate,
      totalSeats: seats.length,
      bookedSeats,
      availableSeats: seats.length - bookedSeats,
      seats,
      decks,
    },
  });
};

/**
 * POST /search/vehicles
 * Body: { origin: {lat,lng}, destination: {lat,lng}, passengers, distanceKm? }
 * Whole-vehicle group options with a server-side fare estimate from the vehicle's SetPrice.
 */
export const searchVehicles = async (req, res) => {
  const { origin, destination } = req.body || {};
  const passengers = Math.max(1, Math.floor(Number(req.body?.passengers) || 1));

  const from = readCoords(origin);
  const to = readCoords(destination);
  const providedDistance = Number(req.body?.distanceKm);
  let distanceKm = null;
  if (from && to) {
    distanceKm = Math.max(1, Math.round(haversineKm(from.lat, from.lng, to.lat, to.lng)));
  } else if (Number.isFinite(providedDistance) && providedDistance > 0) {
    distanceKm = Math.round(providedDistance);
  }
  if (distanceKm === null) {
    throw new ApiError(400, 'origin and destination coordinates (or distanceKm) are required');
  }

  const vehicles = await Vehicle.find({ category: 'group', status: 1, active: { $ne: false } }).lean();
  const prices = await SetPrice.find({
    vehicle_type: { $in: vehicles.map((item) => item._id) },
    status: 'active',
    active: 1,
  })
    .sort({ updatedAt: -1 })
    .lean();
  const priceByVehicle = new Map();
  prices.forEach((price) => {
    const key = String(price.vehicle_type);
    if (!priceByVehicle.has(key)) priceByVehicle.set(key, price);
  });

  const results = vehicles
    .map((vehicle) => {
      const price = priceByVehicle.get(String(vehicle._id));
      const capacity = Number(vehicle.capacity || 0);
      let fare = null;
      if (price) {
        const basePrice = Number(price.base_price || 0);
        const baseDistance = Number(price.base_distance || 0);
        const perKm = Number(price.price_per_distance || 0);
        const baseFare = Math.round(basePrice + Math.max(0, distanceKm - baseDistance) * perKm);
        const taxPercent = Math.max(0, Number(vehicle.service_tax || 0));
        const tax = Math.round((baseFare * taxPercent) / 100);
        fare = {
          basePrice,
          baseDistanceKm: baseDistance,
          perKm,
          distanceKm,
          baseFare,
          taxPercent,
          tax,
          total: baseFare + tax,
          waitingChargePerMin: Number(price.waiting_charge || 0),
          freeWaitingMinutes: Number(price.free_waiting_before || 0),
          cancellationFee: Number(price.user_cancellation_fee || 0),
        };
      }

      return {
        id: String(vehicle._id),
        name: vehicle.name,
        shortDescription: vehicle.short_description || '',
        description: vehicle.description || '',
        image: vehicle.image || '',
        capacity,
        luggageCapacity: Number(vehicle.luggage_capacity || 0),
        fitsPassengers: capacity >= passengers,
        priced: Boolean(fare),
        estimatedFare: fare?.total ?? null,
        fare,
      };
    })
    .sort((a, b) => Number(b.fitsPassengers) - Number(a.fitsPassengers) || a.capacity - b.capacity);

  res.json({
    success: true,
    data: {
      passengers,
      distanceKm,
      vehicles: results,
      results,
    },
  });
};
