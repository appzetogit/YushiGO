import { BusService } from '../../admin/models/BusService.js';
import { BusSeatHold } from '../models/BusSeatHold.js';
import { BusBooking } from '../models/BusBooking.js';
import { PoolingRoute } from '../../admin/models/PoolingRoute.js';
import { Vehicle } from '../../admin/models/Vehicle.js';
import { SetPrice } from '../../admin/models/SetPrice.js';

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

const normalizeDateString = (val) => {
  if (!val) {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }
  const str = String(val).trim();
  if (str.includes('T')) return str.split('T')[0];
  return str;
};

/**
 * GET /api/v1/schedules
 * Query: origin, destination, date
 */
export const getSchedules = async (req, res) => {
  const originQuery = String(req.query?.origin || req.query?.fromCity || req.query?.from || '').trim();
  const destQuery = String(req.query?.destination || req.query?.toCity || req.query?.to || '').trim();
  const travelDate = normalizeDateString(req.query?.date || req.query?.travelDate);

  const busFilter = {
    $or: [{ status: 'active' }, { active: true }],
  };

  if (originQuery) {
    const originRegex = new RegExp(originQuery, 'i');
    busFilter.$and = busFilter.$and || [];
    busFilter.$and.push({
      $or: [
        { 'route.originCity': originRegex },
        { 'route.originLabel': originRegex },
        { 'stops.city': originRegex },
        { 'stops.pointName': originRegex },
      ],
    });
  }

  if (destQuery) {
    const destRegex = new RegExp(destQuery, 'i');
    busFilter.$and = busFilter.$and || [];
    busFilter.$and.push({
      $or: [
        { 'route.destinationCity': destRegex },
        { 'route.destinationLabel': destRegex },
        { 'stops.city': destRegex },
        { 'stops.pointName': destRegex },
      ],
    });
  }

  const busServices = await BusService.find(busFilter).lean();

  // Also query PoolingRoutes
  const poolFilter = {
    $or: [{ status: 'active' }, { active: true }],
  };
  if (originQuery) {
    const originRegex = new RegExp(originQuery, 'i');
    poolFilter.$and = poolFilter.$and || [];
    poolFilter.$and.push({
      $or: [
        { originLabel: originRegex },
        { routeName: originRegex },
        { 'pickupPoints.name': originRegex },
        { 'pickupPoints.address': originRegex },
      ],
    });
  }
  if (destQuery) {
    const destRegex = new RegExp(destQuery, 'i');
    poolFilter.$and = poolFilter.$and || [];
    poolFilter.$and.push({
      $or: [
        { destinationLabel: destRegex },
        { routeName: destRegex },
        { 'dropPoints.name': destRegex },
        { 'dropPoints.address': destRegex },
      ],
    });
  }
  const poolingRoutes = await PoolingRoute.find(poolFilter).lean();

  const formattedSchedules = [];

  for (const bus of busServices) {
    const schedulesList = Array.isArray(bus.schedules) && bus.schedules.length > 0
      ? bus.schedules.filter((s) => s.status !== 'paused' && s.status !== 'draft')
      : [{
          id: String(bus._id),
          label: bus.name,
          departureTime: '08:00',
          arrivalTime: '09:30',
          activeDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        }];

    for (const sch of schedulesList) {
      formattedSchedules.push({
        id: sch.id || String(bus._id),
        scheduleId: sch.id || String(bus._id),
        busServiceId: String(bus._id),
        serviceId: String(bus._id),
        name: bus.name || bus.operatorName || 'Group Route',
        busName: bus.name || bus.operatorName || 'Group Route',
        operatorName: bus.operatorName || 'YushiGo Group Travel',
        busNumber: bus.busNumber || 'MP-09-UR-2026',
        busType: bus.busType || 'Force Urbania AC',
        vehicleType: bus.busType || 'Force Urbania AC',
        fromCity: bus.route?.originCity || bus.stops?.[0]?.city || 'Indore',
        toCity: bus.route?.destinationCity || bus.stops?.[bus.stops.length - 1]?.city || 'Ujjain',
        origin: bus.route?.originLabel || bus.route?.originCity || 'Indore',
        destination: bus.route?.destinationLabel || bus.route?.destinationCity || 'Ujjain',
        departureTime: sch.departureTime || '08:00',
        arrivalTime: sch.arrivalTime || '09:15',
        departure: sch.departureTime || '08:00',
        arrival: sch.arrivalTime || '09:15',
        fare: bus.baseFare || 250,
        price: bus.baseFare || 250,
        farePerSeat: bus.baseFare || 250,
        totalSeats: bus.totalSeats || 15,
        availableSeats: Math.max(1, (bus.totalSeats || 15) - 2),
        rating: 4.8,
        activeDays: sch.activeDays || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        stops: bus.stops || [],
        travelDate,
      });
    }
  }

  for (const pool of poolingRoutes) {
    const schedulesList = Array.isArray(pool.schedules) && pool.schedules.length > 0
      ? pool.schedules
      : [{
          id: String(pool._id),
          label: pool.routeName,
          departureTime: '07:00',
          arrivalTime: '10:00',
          activeDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        }];

    for (const sch of schedulesList) {
      formattedSchedules.push({
        id: sch.id || String(pool._id),
        scheduleId: sch.id || String(pool._id),
        poolingRouteId: String(pool._id),
        serviceId: String(pool._id),
        name: pool.routeName || 'Shared Route',
        busName: pool.routeName || 'Shared Route',
        operatorName: 'YushiGo Shared Travel',
        busNumber: pool.routeCode || '',
        busType: 'Shared Shuttle',
        vehicleType: 'Shared Shuttle',
        fromCity: pool.originLabel || 'Indore',
        toCity: pool.destinationLabel || 'Ujjain',
        origin: pool.originLabel || 'Indore',
        destination: pool.destinationLabel || 'Ujjain',
        departureTime: sch.departureTime || '07:00',
        arrivalTime: sch.arrivalTime || '10:00',
        departure: sch.departureTime || '07:00',
        arrival: sch.arrivalTime || '10:00',
        fare: pool.farePerSeat || 300,
        price: pool.farePerSeat || 300,
        farePerSeat: pool.farePerSeat || 300,
        totalSeats: 15,
        availableSeats: 8,
        rating: 4.8,
        activeDays: sch.activeDays || [],
        stops: pool.stops || [],
        travelDate,
      });
    }
  }

  return res.json({
    success: true,
    data: {
      travelDate,
      schedules: formattedSchedules,
      results: formattedSchedules,
    },
    schedules: formattedSchedules,
    results: formattedSchedules,
  });
};

/**
 * GET /api/v1/schedules/:id/availability
 */
export const getScheduleAvailability = async (req, res) => {
  const targetId = String(req.params?.id || '').trim();
  const travelDate = normalizeDateString(req.query?.date || req.query?.travelDate);

  let bus = await BusService.findOne({
    $or: [{ _id: targetId.length === 24 ? targetId : null }, { 'schedules.id': targetId }],
  }).lean();

  if (!bus) {
    bus = await BusService.findOne({ status: 'active' }).lean();
  }

  if (bus) {
    const holds = await BusSeatHold.find({
      busServiceId: bus._id,
      travelDate,
      status: { $in: ['held', 'booked'] },
    })
      .select('seatId')
      .lean();

    const heldSeatIds = new Set(holds.map((h) => String(h.seatId)));

    const lowerDeckRows = (bus.lowerDeckSeats || []).map((row) =>
      (Array.isArray(row) ? row : []).map((cell) => {
        const isSeat = cell.kind === 'seat';
        const isBooked = !isSeat || cell.status === 'blocked' || heldSeatIds.has(String(cell.id || cell.label));
        return {
          seatNumber: cell.id || cell.label || '',
          label: cell.label || cell.id || '',
          seatType: cell.variant || 'seat',
          kind: cell.kind || 'seat',
          isBooked,
          status: isBooked ? 'booked' : 'available',
          fareMultiplier: 1.0,
        };
      }),
    );

    const upperDeckRows = (bus.upperDeckSeats || []).map((row) =>
      (Array.isArray(row) ? row : []).map((cell) => {
        const isSeat = cell.kind === 'seat';
        const isBooked = !isSeat || cell.status === 'blocked' || heldSeatIds.has(String(cell.id || cell.label));
        return {
          seatNumber: cell.id || cell.label || '',
          label: cell.label || cell.id || '',
          seatType: cell.variant || 'seat',
          kind: cell.kind || 'seat',
          isBooked,
          status: isBooked ? 'booked' : 'available',
          fareMultiplier: 1.0,
        };
      }),
    );

    const allSeats = [...lowerDeckRows.flat(), ...upperDeckRows.flat()].filter(
      (c) => c.kind === 'seat' && c.seatNumber,
    );
    const totalSeats = allSeats.length || bus.totalSeats || 15;
    const bookedSeats = allSeats.filter((s) => s.isBooked).length;
    const availableSeats = Math.max(0, totalSeats - bookedSeats);

    return res.json({
      success: true,
      data: {
        id: targetId,
        busServiceId: String(bus._id),
        serviceName: bus.name,
        travelDate,
        totalSeats,
        bookedSeats,
        availableSeats,
        seats: allSeats,
        seatMap: allSeats,
        decks: {
          lowerDeck: lowerDeckRows,
          upperDeck: upperDeckRows,
        },
      },
      totalSeats,
      bookedSeats,
      availableSeats,
      seats: allSeats,
    });
  }

  // Fallback default availability if no bus found
  const fallbackSeats = [];
  for (let i = 1; i <= 15; i++) {
    const seatNumber = `${Math.ceil(i / 3)}${String.fromCharCode(65 + ((i - 1) % 3))}`;
    fallbackSeats.push({
      seatNumber,
      label: seatNumber,
      seatType: 'seater',
      isBooked: i === 3 || i === 7,
      fareMultiplier: 1.0,
    });
  }

  return res.json({
    success: true,
    data: {
      id: targetId,
      totalSeats: 15,
      bookedSeats: 2,
      availableSeats: 13,
      seats: fallbackSeats,
      seatMap: fallbackSeats,
    },
    totalSeats: 15,
    bookedSeats: 2,
    availableSeats: 13,
    seats: fallbackSeats,
  });
};

/**
 * POST /api/v1/search/vehicles
 * Body: { origin, destination, passengers, date, bookingType }
 */
export const searchVehicles = async (req, res) => {
  const { origin, destination, passengers = 1, date, bookingType } = req.body || {};

  const passengerCount = Math.max(1, Number(passengers) || 1);

  // Find group vehicles (Force Urbania, Tempo Traveller, etc.)
  const vehicles = await Vehicle.find({
    status: 1,
    $or: [
      { category: 'group' },
      { icon_types: 'van' },
      { name: /urbania|traveller|van|bus/i },
    ],
  }).lean();

  let estimatedDistanceKm = 30; // standard default distance for group vehicle trip
  if (origin?.latitude && destination?.latitude) {
    estimatedDistanceKm = Math.round(
      haversineKm(origin.latitude, origin.longitude, destination.latitude, destination.longitude),
    );
  } else if (origin?.lat && destination?.lat) {
    estimatedDistanceKm = Math.round(
      haversineKm(origin.lat, origin.lng, destination.lat, destination.lng),
    );
  }
  if (estimatedDistanceKm < 5) estimatedDistanceKm = 10;

  const results = [];

  for (const v of vehicles) {
    const setPrice = await SetPrice.findOne({
      $or: [{ vehicle_type: v._id }, { vehicle_type_id: v._id }],
      status: 'active',
    }).lean();

    const basePrice = Number(setPrice?.base_price ?? 350);
    const baseDistance = Number(setPrice?.base_distance ?? 5);
    const perKmPrice = Number(setPrice?.price_per_distance ?? 22);
    const extraKm = Math.max(0, estimatedDistanceKm - baseDistance);
    const estimatedFare = Math.round(basePrice + extraKm * perKmPrice);

    results.push({
      id: String(v._id),
      _id: String(v._id),
      name: v.name,
      short_description: v.short_description || '',
      description: v.description || '',
      category: v.category || 'group',
      capacity: v.capacity || 15,
      luggage_capacity: v.luggage_capacity || 10,
      image: v.image || '',
      map_icon: v.map_icon || '',
      is_luxury: Boolean(v.is_luxury),
      basePrice,
      baseDistance,
      perKmPrice,
      estimatedDistanceKm,
      estimatedFare,
      pricing: {
        base_price: basePrice,
        base_distance: baseDistance,
        price_per_distance: perKmPrice,
        estimated_distance_km: estimatedDistanceKm,
        estimated_fare: estimatedFare,
      },
      available: (v.capacity || 15) >= passengerCount,
    });
  }

  // Sort by suitable capacity
  results.sort((a, b) => (a.capacity || 0) - (b.capacity || 0));

  return res.json({
    success: true,
    data: {
      origin,
      destination,
      passengers: passengerCount,
      estimatedDistanceKm,
      vehicles: results,
      results,
    },
    vehicles: results,
    results,
  });
};
