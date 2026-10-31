/**
 * Seed the Group & Large Vehicles module (Force Urbania, Tempo Traveller,
 * Luxury Van, Mini Bus):
 *   1. group vehicle types (whole-vehicle bookings),
 *   2. a ride SetPrice for each of them in every active zone,
 *   3. published seat-based group trips (BusService with vehicleKind) with
 *      seat layouts, boarding points, schedules and cancellation rules.
 *
 * Records go through the same admin service functions the admin panel uses.
 * Existing records (matched by vehicle name, zone + vehicle, or service number)
 * are left untouched, so it is safe to re-run and never overwrites admin edits.
 *
 *   node scripts/seedGroupVehicles.js           # dry run, prints the plan
 *   node scripts/seedGroupVehicles.js --apply   # writes
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const apply = process.argv.includes('--apply');

const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { SetPrice } = await import('../src/modules/taxi/admin/models/SetPrice.js');
const { BusService } = await import('../src/modules/taxi/admin/models/BusService.js');
const { Zone } = await import('../src/modules/taxi/driver/models/Zone.js');
const { createVehicleType, createSetPrice, createBusService } = await import(
  '../src/modules/taxi/admin/services/adminService.js'
);

const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const VEHICLE_TYPES = [
  {
    name: 'Tempo Traveller',
    short_description: '12 seats | AC | Push-back seats',
    description: 'AC, push-back seats, music system, roof carrier for luggage',
    capacity: 12,
    luggage_capacity: 10,
    price: { base_price: 1500, base_distance: 10, price_per_distance: 24, waiting_charge: 3, free_waiting_before: 15, user_cancellation_fee: 300 },
  },
  {
    name: 'Force Urbania',
    short_description: '17 seats | AC | Premium cabin',
    description: 'AC, reclining seats, individual reading lights, USB charging, large boot',
    capacity: 17,
    luggage_capacity: 14,
    price: { base_price: 2500, base_distance: 10, price_per_distance: 32, waiting_charge: 4, free_waiting_before: 15, user_cancellation_fee: 500 },
  },
  {
    name: 'Luxury Van',
    short_description: '9 seats | Captain seats | Premium',
    description: 'Captain seats, ambient lighting, refrigerator, entertainment screen',
    capacity: 9,
    luggage_capacity: 8,
    price: { base_price: 3000, base_distance: 10, price_per_distance: 38, waiting_charge: 5, free_waiting_before: 15, user_cancellation_fee: 600 },
  },
  {
    name: 'Mini Bus',
    short_description: '26 seats | AC | Ideal for large groups',
    description: 'AC, 2x2 seating, PA system, large luggage hold',
    capacity: 26,
    luggage_capacity: 26,
    price: { base_price: 4000, base_distance: 10, price_per_distance: 45, waiting_charge: 6, free_waiting_before: 20, user_cancellation_fee: 800 },
  },
];

// 2+1 rows for vans (seat, seat, aisle, seat); 2+2 rows for the mini bus.
const buildDeck = (rows, pattern) =>
  Array.from({ length: rows }, (_, rowIndex) => {
    let column = 0;
    return pattern.map((cell) => {
      if (cell === '_') return { kind: 'aisle' };
      column += 1;
      const label = `${rowIndex + 1}${String.fromCharCode(64 + column)}`;
      return { kind: 'seat', id: `S${label}`, label, variant: 'seat', status: 'available' };
    });
  });

const CANCELLATION_RULES = [
  { id: 'cancel-24h', label: 'More than 24h before departure', hoursBeforeDeparture: 24, refundType: 'percentage', refundValue: 90 },
  { id: 'cancel-6h', label: '6 to 24h before departure', hoursBeforeDeparture: 6, refundType: 'percentage', refundValue: 50 },
  { id: 'cancel-0h', label: 'Less than 6h before departure', hoursBeforeDeparture: 0, refundType: 'none', refundValue: 0 },
];

const GROUP_TRIPS = [
  {
    serviceNumber: 'YG-URB-IDR-UJN',
    vehicleKind: 'urbania',
    busName: 'Force Urbania Shuttle',
    operatorName: 'YushiGo Group Travel',
    coachType: 'Force Urbania AC',
    busCategory: 'Seater',
    registrationNumber: 'MP09AB1701',
    seatPrice: 299,
    serviceTaxPercentage: 5,
    amenities: ['AC', 'Reclining seats', 'USB charging', 'Water bottle'],
    blueprint: { templateKey: 'seater_2_1', lowerDeck: buildDeck(5, ['s', 's', '_', 's']) },
    route: {
      routeName: 'Indore - Ujjain',
      originCity: 'Indore',
      destinationCity: 'Ujjain',
      originCoords: { lat: 22.7196, lng: 75.8577 },
      destinationCoords: { lat: 23.1765, lng: 75.7885 },
      distanceKm: '56',
      durationHours: '1.5',
      stops: [
        { id: 'idr-vijay-nagar', city: 'Indore', pointName: 'Vijay Nagar Square', stopType: 'pickup', departureTime: '07:00' },
        { id: 'idr-rajwada', city: 'Indore', pointName: 'Rajwada', stopType: 'pickup', departureTime: '07:20' },
        { id: 'ujn-mahakal', city: 'Ujjain', pointName: 'Mahakal Temple Gate', stopType: 'drop', arrivalTime: '08:35' },
      ],
    },
    schedules: [
      { id: 'urb-idr-ujn-0700', label: 'Morning darshan', departureTime: '07:00', arrivalTime: '08:35', activeDays: ALL_DAYS },
      { id: 'urb-idr-ujn-1500', label: 'Afternoon', departureTime: '15:00', arrivalTime: '16:35', activeDays: ALL_DAYS },
    ],
  },
  {
    serviceNumber: 'YG-TT-IDR-BPL',
    vehicleKind: 'traveller',
    busName: 'Tempo Traveller Express',
    operatorName: 'YushiGo Group Travel',
    coachType: 'Tempo Traveller AC',
    busCategory: 'Seater',
    registrationNumber: 'MP09CD1202',
    seatPrice: 549,
    serviceTaxPercentage: 5,
    amenities: ['AC', 'Push-back seats', 'Music system'],
    blueprint: { templateKey: 'seater_2_1', lowerDeck: buildDeck(4, ['s', 's', '_', 's']) },
    route: {
      routeName: 'Indore - Bhopal',
      originCity: 'Indore',
      destinationCity: 'Bhopal',
      originCoords: { lat: 22.7196, lng: 75.8577 },
      destinationCoords: { lat: 23.2599, lng: 77.4126 },
      distanceKm: '195',
      durationHours: '4',
      stops: [
        { id: 'idr-bhawarkua', city: 'Indore', pointName: 'Bhawarkua Square', stopType: 'pickup', departureTime: '06:30' },
        { id: 'dewas-naka', city: 'Dewas', pointName: 'Dewas Naka', stopType: 'both', departureTime: '07:10' },
        { id: 'bpl-mp-nagar', city: 'Bhopal', pointName: 'MP Nagar Zone 1', stopType: 'drop', arrivalTime: '10:30' },
      ],
    },
    schedules: [
      { id: 'tt-idr-bpl-0630', label: 'Early morning', departureTime: '06:30', arrivalTime: '10:30', activeDays: ALL_DAYS },
      { id: 'tt-idr-bpl-1700', label: 'Evening', departureTime: '17:00', arrivalTime: '21:00', activeDays: ['Fri', 'Sat', 'Sun'] },
    ],
  },
  {
    serviceNumber: 'YG-LV-MUM-PUN',
    vehicleKind: 'luxury_van',
    busName: 'Luxury Van Executive',
    operatorName: 'YushiGo Group Travel',
    coachType: 'Luxury Van AC',
    busCategory: 'Seater',
    registrationNumber: 'MH12EF0903',
    seatPrice: 899,
    serviceTaxPercentage: 5,
    amenities: ['AC', 'Captain seats', 'Refreshments', 'Wi-Fi'],
    blueprint: { templateKey: 'seater_2_1', lowerDeck: buildDeck(4, ['s', '_', 's']) },
    route: {
      routeName: 'Mumbai - Pune',
      originCity: 'Mumbai',
      destinationCity: 'Pune',
      originCoords: { lat: 19.076, lng: 72.8777 },
      destinationCoords: { lat: 18.5204, lng: 73.8567 },
      distanceKm: '150',
      durationHours: '3',
      stops: [
        { id: 'mum-dadar', city: 'Mumbai', pointName: 'Dadar TT Circle', stopType: 'pickup', departureTime: '08:00' },
        { id: 'mum-vashi', city: 'Navi Mumbai', pointName: 'Vashi Plaza', stopType: 'pickup', departureTime: '08:40' },
        { id: 'pun-shivajinagar', city: 'Pune', pointName: 'Shivajinagar', stopType: 'drop', arrivalTime: '11:00' },
      ],
    },
    schedules: [
      { id: 'lv-mum-pun-0800', label: 'Business morning', departureTime: '08:00', arrivalTime: '11:00', activeDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
    ],
  },
  {
    serviceNumber: 'YG-MB-DEL-AGR',
    vehicleKind: 'mini_bus',
    busName: 'Mini Bus Heritage Tour',
    operatorName: 'YushiGo Group Travel',
    coachType: 'Mini Bus AC',
    busCategory: 'Seater',
    registrationNumber: 'DL01GH2604',
    seatPrice: 699,
    serviceTaxPercentage: 5,
    amenities: ['AC', '2x2 seating', 'Tour guide', 'Water bottle'],
    blueprint: { templateKey: 'seater_2_2', lowerDeck: buildDeck(6, ['s', 's', '_', 's', 's']) },
    route: {
      routeName: 'Delhi - Agra',
      originCity: 'Delhi',
      destinationCity: 'Agra',
      originCoords: { lat: 28.6139, lng: 77.209 },
      destinationCoords: { lat: 27.1767, lng: 78.0081 },
      distanceKm: '233',
      durationHours: '4',
      stops: [
        { id: 'del-cp', city: 'Delhi', pointName: 'Connaught Place', stopType: 'pickup', departureTime: '06:00' },
        { id: 'del-sarai-kale-khan', city: 'Delhi', pointName: 'Sarai Kale Khan', stopType: 'pickup', departureTime: '06:30' },
        { id: 'agr-taj-east-gate', city: 'Agra', pointName: 'Taj Mahal East Gate', stopType: 'drop', arrivalTime: '10:00' },
      ],
    },
    schedules: [
      { id: 'mb-del-agr-0600', label: 'Same-day Taj tour', departureTime: '06:00', arrivalTime: '10:00', activeDays: ['Sat', 'Sun'] },
    ],
  },
];

const log = (...args) => console.log(apply ? '[apply]' : '[dry-run]', ...args);

const seedVehicleTypes = async () => {
  const vehicles = [];
  for (const spec of VEHICLE_TYPES) {
    const existing = await Vehicle.findOne({ name: new RegExp(`^${spec.name}$`, 'i') }).lean();
    if (existing) {
      log(`vehicle type "${spec.name}" exists (category "${existing.category || ''}"), kept as is`);
      if (existing.category !== 'group') {
        log(`  note: set its category to "Group (Urbania / Traveller)" in Admin > Vehicle Types to list it under Group & Large Vehicles`);
      }
      vehicles.push({ spec, vehicle: existing });
      continue;
    }
    log(`create vehicle type "${spec.name}" (${spec.capacity} seats)`);
    if (apply) {
      const created = await createVehicleType({
        name: spec.name,
        short_description: spec.short_description,
        description: spec.description,
        transport_type: 'taxi',
        category: 'group',
        icon_types: 'car',
        capacity: spec.capacity,
        luggage_capacity: spec.luggage_capacity,
        status: 1,
      });
      vehicles.push({ spec, vehicle: { _id: created._id || created.id } });
    } else {
      vehicles.push({ spec, vehicle: null });
    }
  }
  return vehicles;
};

const seedPrices = async (vehicles) => {
  // Same rule as dispatch (matchingService): a zone is usable unless explicitly switched off.
  const activeZones = await Zone.find({ active: { $ne: false }, status: { $ne: 'inactive' } }).select('_id name').lean();
  // Without zones the ride prices are global (zone_id null), as the existing ones are.
  const zones = activeZones.length > 0 ? activeZones : [{ _id: null, name: 'all areas (no zones set up)' }];
  for (const { spec, vehicle } of vehicles) {
    for (const zone of zones) {
      const exists = vehicle
        ? await SetPrice.exists({ zone_id: zone._id, vehicle_type: vehicle._id, pricing_scope: 'ride' })
        : false;
      if (exists) {
        log(`price for "${spec.name}" in zone "${zone.name}" exists, kept as is`);
        continue;
      }
      log(`create price for "${spec.name}" in zone "${zone.name}": base ${spec.price.base_price}, ${spec.price.price_per_distance}/km`);
      if (apply) {
        await createSetPrice({
          zone_id: zone._id,
          vehicle_type: vehicle._id,
          transport_type: 'taxi',
          pricing_scope: 'ride',
          payment_type: ['cash', 'online'],
          user_cancellation_fee_type: 'fixed',
          support_outstation: 1,
          outstation_base_price: spec.price.base_price,
          outstation_base_distance: spec.price.base_distance,
          outstation_price_per_distance: spec.price.price_per_distance,
          ...spec.price,
        });
      }
    }
  }
};

const seedGroupTrips = async () => {
  for (const trip of GROUP_TRIPS) {
    const existing = await BusService.exists({ serviceNumber: trip.serviceNumber });
    if (existing) {
      log(`group trip ${trip.serviceNumber} exists, kept as is`);
      continue;
    }
    const seats = trip.blueprint.lowerDeck.flat().filter((cell) => cell.kind === 'seat').length;
    log(`create group trip ${trip.serviceNumber}: ${trip.route.routeName}, ${trip.vehicleKind}, ${seats} seats, ${trip.schedules.length} schedule(s)`);
    if (apply) {
      await createBusService({
        ...trip,
        variantPricing: { seat: trip.seatPrice },
        fareCurrency: 'INR',
        cancellationRules: CANCELLATION_RULES,
        cancellationPolicy: 'Refund depends on how early you cancel. See the cancellation rules.',
        boardingPolicy: 'Reach the boarding point 15 minutes before departure with a valid ID.',
        luggagePolicy: 'One bag and one handbag per passenger.',
        blueprint: { ...trip.blueprint, upperDeck: [] },
        schedules: trip.schedules.map((schedule) => ({ ...schedule, status: 'active' })),
        status: 'active',
      });
    }
  }
};

try {
  await mongoose.connect(process.env.MONGODB_URI);
  const vehicles = await seedVehicleTypes();
  await seedPrices(vehicles);
  await seedGroupTrips();
  log(apply ? 'done' : 'nothing written; re-run with --apply to write');
} catch (error) {
  console.error('Failed:', error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
