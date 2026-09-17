/**
 * Carpool — departure timezone and ride expiry.
 *
 *   node tests/carpool/expiry.mjs
 *
 * Covers the checklist in CARPOOL_RIDE_EXPIRY_BACKEND.md §6. Rides cannot be
 * published in the past, so "a ride that departed" is set up by moving
 * departureAt and expiresAt on a published ride directly.
 */
import mongoose from 'mongoose';

const DB_NAME = `carpool_expiry_${Date.now()}`;
process.env.MONGODB_URI = process.env.CARPOOL_TEST_URI
  || `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
process.env.CARPOOL_INSTANT_BOOKING = 'false';
process.env.CARPOOL_TIMEZONE = 'Asia/Kolkata';
process.env.CARPOOL_EXPIRY_GRACE_MINUTES = '120';

const rideService = await import('../../src/modules/taxi/carpool/services/carpoolRideService.js');
const vehicleService = await import('../../src/modules/taxi/carpool/services/carpoolVehicleService.js');
const bookingService = await import('../../src/modules/taxi/carpool/services/carpoolBookingService.js');
const tripsService = await import('../../src/modules/taxi/carpool/services/carpoolTripsService.js');
const expiry = await import('../../src/modules/taxi/carpool/services/carpoolExpiryService.js');
const { todayInZone, wallClockParts } = await import('../../src/modules/taxi/carpool/services/departureTime.js');
const { migrateCarpoolDepartureTimes } = await import('../../scripts/migrateCarpoolDepartureTimes.js');
const { CarpoolRide } = await import('../../src/modules/taxi/carpool/models/CarpoolRide.js');
const { CarpoolBooking } = await import('../../src/modules/taxi/carpool/models/CarpoolBooking.js');

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

for (const name of ['TaxiCarpoolVehicle', 'TaxiCarpoolRide', 'TaxiCarpoolBooking', 'TaxiCarpoolUserStats']) {
  await mongoose.model(name).createCollection().catch(() => null);
}
await mongoose.model('TaxiCarpoolBooking').syncIndexes();
await mongoose.model('TaxiCarpoolRide').syncIndexes();

let pass = 0;
let fail = 0;

const check = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  FAIL  ${name} -> ${error.message}`);
  }
};

const expectReject = async (name, code, fn, messageIncludes = null) => {
  await check(name, async () => {
    try {
      await fn();
    } catch (error) {
      if (error.code !== code) throw new Error(`expected ${code}, got ${error.code} (${error.message})`);
      if (messageIncludes && !String(error.message).includes(messageIncludes)) {
        throw new Error(`message was "${error.message}"`);
      }
      return;
    }
    throw new Error('expected rejection, call succeeded');
  });
};

const host = new mongoose.Types.ObjectId();
const alice = new mongoose.Types.ObjectId();
const bob = new mongoose.Types.ObjectId();
const carol = new mongoose.Types.ObjectId();

await mongoose.connection.collection('taxiusers').insertMany([
  { _id: host, name: 'Varun', gender: 'male' },
  { _id: alice, name: 'Alice', gender: 'female' },
  { _id: bob, name: 'Bob', gender: 'male' },
  { _id: carol, name: 'Carol', gender: 'female' },
]);

const INDORE = { name: 'Indore', lat: 22.7196, lng: 75.8577 };
const UJJAIN = { name: 'Ujjain', lat: 23.1765, lng: 75.7885 };

const addDays = (yyyyMmDd, days) => {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const todayIst = todayInZone();
const tomorrowIst = addDays(todayIst, 1);

const vehicle = await vehicleService.createVehicle({
  userId: host,
  payload: { model: 'Hyundai i20', registrationNumber: 'MP09AB1234', seatCapacity: 4 },
});

const payload = (extra = {}) => ({
  vehicle_id: vehicle.id, origin: INDORE, destination: UJJAIN, pickup: INDORE, drop: UJJAIN,
  date: tomorrowIst, departure_time: '09:00', available_seats: 3, price_per_seat: 150, ...extra,
});

const publish = (extra) => rideService.createRide({ userId: host, payload: payload(extra) });

/** Pretend the ride left `minutesAgo` minutes ago. */
const departedAgo = async (rideId, minutesAgo) => {
  const departureAt = new Date(Date.now() - minutesAgo * 60_000);
  await CarpoolRide.updateOne(
    { _id: rideId },
    { $set: { departureAt, expiresAt: new Date(departureAt.getTime() + 120 * 60_000) } },
  );
};

const bookingPayload = { seat_count: 1, pickup: INDORE, drop: UJJAIN };

console.log('\nTASK 1 — DEPARTURE TIMEZONE');

// Test 1. "00:00 today" is always already past in IST, except in the first
// minute of the day, which is skipped rather than flaky.
if (wallClockParts(new Date()).hour === 0 && wallClockParts(new Date()).minute === 0) {
  console.log('  SKIP  earlier-today check (running at IST midnight)');
} else {
  await expectReject(
    'publishing an earlier time today is refused with the reason',
    'INVALID_ROUTE',
    () => publish({ date: todayIst, departure_time: '00:00' }),
    'That time has already passed today.',
  );
}

await expectReject('a past date keeps the general message', 'INVALID_ROUTE',
  () => publish({ date: '2020-01-01' }), 'Departure must be in the future.');

await expectReject('a date that does not exist is refused', 'INVALID_ROUTE',
  () => publish({ date: '2027-02-30' }), 'do not form a valid time');

await check('09:00 IST tomorrow is stored as 03:30Z', async () => {
  const ride = await publish();
  const expected = `${tomorrowIst}T03:30:00.000Z`;
  if (new Date(ride.departureAt).toISOString() !== expected) {
    throw new Error(`got ${new Date(ride.departureAt).toISOString()}, want ${expected}`);
  }
  if (ride.date !== tomorrowIst || ride.departureTime !== '09:00') {
    throw new Error('date/departureTime not kept verbatim');
  }
});

console.log('\nTASK 2/3 — expiresAt');

await check('expiresAt is departure + grace and is serialized for owner and public', async () => {
  const ride = await publish();
  const want = new Date(ride.departureAt).getTime() + 120 * 60_000;
  if (new Date(ride.expiresAt).getTime() !== want) throw new Error('owner view expiresAt wrong');

  const publicView = await rideService.getRideById({ rideId: ride.rideId, userId: alice });
  if (new Date(publicView.expiresAt).getTime() !== want) throw new Error('public view expiresAt missing');
});

await check('a ride saved without expiresAt derives it instead of failing validation', async () => {
  const ride = await publish();
  await CarpoolRide.collection.updateOne({ _id: new mongoose.Types.ObjectId(ride.rideId) }, { $unset: { expiresAt: '' } });
  const doc = await CarpoolRide.findById(ride.rideId);
  doc.notes = 'edited';
  await doc.save();
  const fresh = await CarpoolRide.findById(ride.rideId);
  if (!fresh.expiresAt) throw new Error('expiresAt not derived');
});

console.log('\nWITHIN THE GRACE WINDOW (test 3)');

await check('30 min after departure: still PUBLISHED, passenger cannot book, host can start', async () => {
  const ride = await publish();
  await departedAgo(ride.rideId, 30);

  await expiry.sweepExpiredRides();
  const doc = await CarpoolRide.findById(ride.rideId);
  if (doc.status !== 'PUBLISHED') throw new Error(`swept too early: ${doc.status}`);

  let refused = false;
  await bookingService.createBooking({ rideId: ride.rideId, userId: alice, payload: bookingPayload })
    .catch((error) => { refused = error.code === 'RIDE_NOT_AVAILABLE'; });
  if (!refused) throw new Error('a departed ride accepted a booking');

  const started = await bookingService.startRide({ rideId: ride.rideId, userId: host });
  if (started.status !== 'STARTED') throw new Error('host could not start within grace');
});

console.log('\nPAST THE WINDOW (tests 4, 5, 6, 7)');

const expiredRide = await publish();
const pendingA = await bookingService.createBooking({ rideId: expiredRide.rideId, userId: alice, payload: bookingPayload });
const pendingB = await bookingService.createBooking({ rideId: expiredRide.rideId, userId: carol, payload: bookingPayload });
const acceptedC = await bookingService.createBooking({ rideId: expiredRide.rideId, userId: bob, payload: bookingPayload });
await bookingService.acceptBooking({ bookingId: acceptedC.bookingId, userId: host });
await departedAgo(expiredRide.rideId, 150);

await check('the sweep expires it', async () => {
  const result = await expiry.sweepExpiredRides();
  if (result.expired < 1) throw new Error(`nothing expired: ${JSON.stringify(result)}`);
  const doc = await CarpoolRide.findById(expiredRide.rideId);
  if (doc.status !== 'EXPIRED') throw new Error(`status ${doc.status}`);
  if (!doc.expiredAt) throw new Error('expiredAt not set');
  if (doc.bookedSeats !== 0) throw new Error(`bookedSeats ${doc.bookedSeats}`);
});

await check('PENDING -> REJECTED and ACCEPTED -> CANCELLED, with reasons, all inactive', async () => {
  const [a, b, c] = await Promise.all([pendingA, pendingB, acceptedC]
    .map((booking) => CarpoolBooking.findById(booking.bookingId)));

  for (const pending of [a, b]) {
    if (pending.status !== 'REJECTED') throw new Error(`pending became ${pending.status}`);
    if (pending.cancellationReason !== 'The ride expired before this request was answered.') throw new Error('pending reason');
    if (!pending.rejectedAt) throw new Error('rejectedAt missing');
  }
  if (c.status !== 'CANCELLED') throw new Error(`accepted became ${c.status}`);
  if (c.cancellationReason !== 'The host did not start this ride.') throw new Error('accepted reason');
  if (c.cancelledBy !== 'system' || !c.cancelledAt || c.seatsHeld !== 0) throw new Error('accepted fields');
  if ([a, b, c].some((booking) => booking.isActive)) throw new Error('a booking is still active');
});

await expectReject('an expired ride cannot be started', 'RIDE_EXPIRED',
  () => bookingService.startRide({ rideId: expiredRide.rideId, userId: host }));

await expectReject('a stranger still gets 403, not a hint the ride expired', 'UNAUTHORIZED_RIDE_ACCESS',
  () => bookingService.startRide({ rideId: expiredRide.rideId, userId: alice }));

await check('passenger opening the ride sees EXPIRED, not owner', async () => {
  const view = await rideService.getRideById({ rideId: expiredRide.rideId, userId: alice });
  if (view.status !== 'EXPIRED' || view.isOwner !== false) throw new Error(JSON.stringify({ s: view.status, o: view.isOwner }));
});

await check('search on a day with only expired rides is empty', async () => {
  const results = await rideService.searchRides({
    userId: alice,
    query: { from_lat: INDORE.lat, from_lng: INDORE.lng, to_lat: UJJAIN.lat, to_lng: UJJAIN.lng, date: tomorrowIst },
  });
  if (results.some((r) => r.rideId === expiredRide.rideId)) throw new Error('expired ride returned by search');
});

await check('home counters and upcoming trips no longer count it', async () => {
  const offered = await tripsService.getMyTrips({ userId: host, type: 'offered', status: 'upcoming' });
  if (offered.offered_rides.some((r) => r.rideId === expiredRide.rideId)) throw new Error('listed as upcoming');
  const cancelled = await tripsService.getMyTrips({ userId: host, type: 'offered', status: 'cancelled' });
  if (!cancelled.offered_rides.some((r) => r.rideId === expiredRide.rideId)) throw new Error('not in cancelled bucket');
  const bookings = await tripsService.getMyTrips({ userId: alice, type: 'passenger', status: 'upcoming' });
  if (bookings.passenger_trips.some((b) => b.rideId === expiredRide.rideId)) throw new Error('passenger still upcoming');
});

await check('unfiltered my-offered-rides still returns every status (app buckets client-side)', async () => {
  const all = await rideService.listMyOfferedRides({ userId: host });
  if (!all.some((r) => r.rideId === expiredRide.rideId && r.status === 'EXPIRED')) throw new Error('expired ride missing');
});

console.log('\nLAZY EXPIRY WITHOUT THE SWEEP');

await check('startRide on a stale ride expires it and refuses', async () => {
  const ride = await publish();
  await departedAgo(ride.rideId, 150);
  let code = null;
  await bookingService.startRide({ rideId: ride.rideId, userId: host }).catch((error) => { code = error.code; });
  if (code !== 'RIDE_EXPIRED') throw new Error(`got ${code}`);
  // The expiry must survive the refusal, not roll back with it.
  const doc = await CarpoolRide.findById(ride.rideId);
  if (doc.status !== 'EXPIRED') throw new Error(`status ${doc.status} — expiry rolled back`);
});

await check('opening a stale ride by id expires it', async () => {
  const ride = await publish();
  await departedAgo(ride.rideId, 150);
  const view = await rideService.getRideById({ rideId: ride.rideId, userId: host });
  if (view.status !== 'EXPIRED') throw new Error(`got ${view.status}`);
});

console.log('\nWHAT MUST NOT EXPIRE (tests 8, 9)');

await check('a STARTED ride past its window is left alone', async () => {
  const ride = await publish();
  await bookingService.startRide({ rideId: ride.rideId, userId: host });
  await departedAgo(ride.rideId, 600);
  await expiry.sweepExpiredRides();
  await rideService.getRideById({ rideId: ride.rideId, userId: alice });
  const doc = await CarpoolRide.findById(ride.rideId);
  if (doc.status !== 'STARTED') throw new Error(`became ${doc.status}`);
});

await check('cancelled and completed rides are left alone', async () => {
  const ride = await publish();
  await bookingService.cancelRide({ rideId: ride.rideId, userId: host, reason: 'x' });
  await departedAgo(ride.rideId, 600);
  await expiry.sweepExpiredRides();
  const doc = await CarpoolRide.findById(ride.rideId);
  if (doc.status !== 'CANCELLED') throw new Error(`became ${doc.status}`);
});

await check('concurrent expiry of one ride happens exactly once', async () => {
  const ride = await publish();
  const booking = await bookingService.createBooking({ rideId: ride.rideId, userId: alice, payload: bookingPayload });
  await departedAgo(ride.rideId, 150);

  const results = await Promise.all([
    expiry.expireRide(ride.rideId),
    expiry.expireRide(ride.rideId),
    expiry.sweepExpiredRides(),
    expiry.sweepExpiredRides(),
  ]);

  const wins = results[0].expired + results[1].expired + results[2].expired + results[3].expired;
  if (wins !== 1) throw new Error(`expired ${wins} times`);

  const b = await CarpoolBooking.findById(booking.bookingId);
  if (b.status !== 'REJECTED') throw new Error(`booking ${b.status}`);
});

console.log('\nMIGRATION (test 10)');

await check('recomputes skewed departureAt, fills expiresAt, and is idempotent', async () => {
  const _id = new mongoose.Types.ObjectId();
  await CarpoolRide.collection.insertOne({
    _id, driverId: host, vehicleId: new mongoose.Types.ObjectId(), status: 'PUBLISHED',
    date: '2026-09-15', departureTime: '09:00', departureAt: new Date('2026-09-15T09:00:00Z'),
    offeredSeats: 2, bookedSeats: 0, pricePerSeat: 100,
  });

  const quiet = () => {};
  const first = await migrateCarpoolDepartureTimes({ apply: true, log: quiet });
  const doc = await CarpoolRide.collection.findOne({ _id });

  if (doc.departureAt.toISOString() !== '2026-09-15T03:30:00.000Z') throw new Error(`departureAt ${doc.departureAt.toISOString()}`);
  if (doc.expiresAt?.toISOString() !== '2026-09-15T05:30:00.000Z') throw new Error(`expiresAt ${doc.expiresAt}`);
  if (first.changed < 1) throw new Error('reported no change');

  const second = await migrateCarpoolDepartureTimes({ apply: true, log: quiet });
  if (second.changed !== 0) throw new Error(`second run changed ${second.changed}`);
});

await check('a dry run writes nothing', async () => {
  const _id = new mongoose.Types.ObjectId();
  const skewed = new Date('2026-10-01T18:00:00Z');
  await CarpoolRide.collection.insertOne({
    _id, driverId: host, vehicleId: new mongoose.Types.ObjectId(), status: 'PUBLISHED',
    date: '2026-10-01', departureTime: '18:00', departureAt: skewed, offeredSeats: 2, bookedSeats: 0, pricePerSeat: 100,
  });
  await migrateCarpoolDepartureTimes({ apply: false, log: () => {} });
  const doc = await CarpoolRide.collection.findOne({ _id });
  if (doc.departureAt.getTime() !== skewed.getTime() || doc.expiresAt) throw new Error('dry run wrote');
});

console.log(`\n${pass} passed, ${fail} failed`);

await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
