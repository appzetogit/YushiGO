/**
 * Carpool — bookings, seat concurrency (§18) and idempotency (§48).
 *
 *   node tests/carpool/booking.mjs
 *
 * Uses a throwaway database. The concurrency checks fire genuinely parallel
 * requests rather than sequential ones — a read-then-write implementation
 * passes a sequential test and still overbooks in production.
 */
import mongoose from 'mongoose';

const DB_NAME = `carpool_test_${Date.now()}`;
process.env.MONGODB_URI = process.env.CARPOOL_TEST_URI
  || `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
process.env.CARPOOL_INSTANT_BOOKING = 'false';

const rideService = await import('../../src/modules/taxi/carpool/services/carpoolRideService.js');
const vehicleService = await import('../../src/modules/taxi/carpool/services/carpoolVehicleService.js');
const bookingService = await import('../../src/modules/taxi/carpool/services/carpoolBookingService.js');
const { CarpoolRide } = await import('../../src/modules/taxi/carpool/models/CarpoolRide.js');

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

for (const name of ['TaxiCarpoolVehicle', 'TaxiCarpoolRide', 'TaxiCarpoolBooking']) {
  await mongoose.model(name).createCollection();
}
// The partial unique index carries the idempotency guarantee, so build it.
await mongoose.model('TaxiCarpoolBooking').syncIndexes();

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

const expectReject = async (name, code, fn) => {
  await check(name, async () => {
    try {
      await fn();
    } catch (error) {
      if (error.code !== code) throw new Error(`expected ${code}, got ${error.code} (${error.message})`);
      return;
    }
    throw new Error('expected rejection, call succeeded');
  });
};

const host = new mongoose.Types.ObjectId();
const alice = new mongoose.Types.ObjectId();
const bob = new mongoose.Types.ObjectId();
const carol = new mongoose.Types.ObjectId();

const INDORE = { name: 'Indore', lat: 22.7196, lng: 75.8577 };
const DEWAS = { name: 'Dewas', lat: 22.9676, lng: 76.0534 };
const UJJAIN = { name: 'Ujjain', lat: 23.1765, lng: 75.7885 };

const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

const vehicle = await vehicleService.createVehicle({
  userId: host,
  payload: { model: 'Hyundai i20', registrationNumber: 'MP09AB1234', seatCapacity: 4 },
});

const publishRide = async (seats = 2) => rideService.createRide({
  userId: host,
  payload: {
    vehicle_id: vehicle.id,
    origin: INDORE,
    destination: UJJAIN,
    pickup: INDORE,
    drop: UJJAIN,
    stops: [{ ...DEWAS, order: 1 }],
    date: tomorrow,
    departure_time: '10:30',
    available_seats: seats,
    price_per_seat: 180,
  },
});

const bookingPayload = (seatCount = 1) => ({
  seat_count: seatCount,
  pickup: DEWAS,
  drop: UJJAIN,
});

console.log('\nPUBLISH VALIDATION');

await expectReject('seats beyond the car capacity are refused', 'INVALID_VEHICLE', () =>
  rideService.createRide({
    userId: host,
    payload: {
      vehicle_id: vehicle.id, origin: INDORE, destination: UJJAIN, pickup: INDORE, drop: UJJAIN,
      date: tomorrow, departure_time: '10:30', available_seats: 9, price_per_seat: 100,
    },
  }));

await expectReject('a departure in the past is refused', 'INVALID_ROUTE', () =>
  rideService.createRide({
    userId: host,
    payload: {
      vehicle_id: vehicle.id, origin: INDORE, destination: UJJAIN, pickup: INDORE, drop: UJJAIN,
      date: '2020-01-01', departure_time: '10:30', available_seats: 2, price_per_seat: 100,
    },
  }));

await expectReject("another user's vehicle cannot be used", 'INVALID_VEHICLE', () =>
  rideService.createRide({
    userId: alice,
    payload: {
      vehicle_id: vehicle.id, origin: INDORE, destination: UJJAIN, pickup: INDORE, drop: UJJAIN,
      date: tomorrow, departure_time: '10:30', available_seats: 2, price_per_seat: 100,
    },
  }));

console.log('\nBOOKING BASICS');

const ride = await publishRide(2);

await expectReject('a host cannot book their own ride', 'CANNOT_BOOK_OWN_RIDE', () =>
  bookingService.createBooking({ rideId: ride.rideId, userId: host, payload: bookingPayload() }));

const aliceBooking = await bookingService.createBooking({
  rideId: ride.rideId, userId: alice, payload: bookingPayload(1),
});

await check('a request is PENDING and holds no seats yet', async () => {
  if (aliceBooking.status !== 'PENDING') throw new Error(`got ${aliceBooking.status}`);
  const fresh = await CarpoolRide.findById(ride.rideId);
  if (fresh.bookedSeats !== 0) throw new Error(`seats held too early: ${fresh.bookedSeats}`);
});

await check('driver_id comes from the ride, not the client', async () => {
  const detail = await bookingService.getBooking({ bookingId: aliceBooking.bookingId, userId: alice });
  if (detail.host.id !== String(host)) throw new Error('host mismatch');
});

await check('total is priced from the ride, not the request', async () => {
  if (aliceBooking.totalAmount !== 180) throw new Error(`got ${aliceBooking.totalAmount}`);
});

console.log('\nIDEMPOTENCY (§48)');

await expectReject('a repeated request is refused while one is open', 'DUPLICATE_BOOKING', () =>
  bookingService.createBooking({ rideId: ride.rideId, userId: alice, payload: bookingPayload(1) }));

await check('two simultaneous double-taps yield exactly one booking', async () => {
  const results = await Promise.allSettled([
    bookingService.createBooking({ rideId: ride.rideId, userId: carol, payload: bookingPayload(1) }),
    bookingService.createBooking({ rideId: ride.rideId, userId: carol, payload: bookingPayload(1) }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (ok.length !== 1) throw new Error(`expected 1 success, got ${ok.length}`);
});

console.log('\nSEAT CONCURRENCY (§18)');

await check('two hosts accepting for the last seat: exactly one wins', async () => {
  const race = await publishRide(1);

  const [first, second] = await Promise.all([
    bookingService.createBooking({ rideId: race.rideId, userId: alice, payload: bookingPayload(1) }),
    bookingService.createBooking({ rideId: race.rideId, userId: bob, payload: bookingPayload(1) }),
  ]);

  // Both requests are valid; only one can be accepted, and the two acceptances
  // are fired in parallel to force the race the specification warns about.
  const results = await Promise.allSettled([
    bookingService.acceptBooking({ bookingId: first.bookingId, userId: host }),
    bookingService.acceptBooking({ bookingId: second.bookingId, userId: host }),
  ]);

  const accepted = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');

  if (accepted.length !== 1) throw new Error(`expected 1 acceptance, got ${accepted.length}`);
  if (refused[0]?.reason?.code !== 'SEATS_UNAVAILABLE') {
    throw new Error(`expected SEATS_UNAVAILABLE, got ${refused[0]?.reason?.code}`);
  }

  const fresh = await CarpoolRide.findById(race.rideId);
  if (fresh.bookedSeats !== 1) throw new Error(`overbooked: bookedSeats=${fresh.bookedSeats}`);
  if (fresh.status !== 'FULL') throw new Error(`expected FULL, got ${fresh.status}`);
});

await check('three parallel acceptances against two seats never exceed capacity', async () => {
  const race = await publishRide(2);

  const requests = await Promise.all([alice, bob, carol].map((passenger) =>
    bookingService.createBooking({ rideId: race.rideId, userId: passenger, payload: bookingPayload(1) })));

  await Promise.allSettled(requests.map((booking) =>
    bookingService.acceptBooking({ bookingId: booking.bookingId, userId: host })));

  const fresh = await CarpoolRide.findById(race.rideId);
  if (fresh.bookedSeats > fresh.offeredSeats) {
    throw new Error(`overbooked: ${fresh.bookedSeats}/${fresh.offeredSeats}`);
  }
  if (fresh.bookedSeats !== 2) throw new Error(`expected 2 seats taken, got ${fresh.bookedSeats}`);
});

console.log('\nSEAT RELEASE');

await check('cancelling an accepted booking returns the seat and reopens the ride', async () => {
  const r = await publishRide(1);
  const booking = await bookingService.createBooking({
    rideId: r.rideId, userId: alice, payload: bookingPayload(1),
  });
  await bookingService.acceptBooking({ bookingId: booking.bookingId, userId: host });

  const full = await CarpoolRide.findById(r.rideId);
  if (full.status !== 'FULL') throw new Error('should be FULL after acceptance');

  await bookingService.cancelBookingByPassenger({ bookingId: booking.bookingId, userId: alice });

  const reopened = await CarpoolRide.findById(r.rideId);
  if (reopened.bookedSeats !== 0) throw new Error(`seats not released: ${reopened.bookedSeats}`);
  if (reopened.status !== 'PUBLISHED') throw new Error(`expected PUBLISHED, got ${reopened.status}`);
});

await check('cancelling a pending booking releases nothing', async () => {
  const r = await publishRide(2);
  const booking = await bookingService.createBooking({
    rideId: r.rideId, userId: bob, payload: bookingPayload(1),
  });
  await bookingService.cancelBookingByPassenger({ bookingId: booking.bookingId, userId: bob });

  const fresh = await CarpoolRide.findById(r.rideId);
  if (fresh.bookedSeats !== 0) throw new Error(`counter drifted to ${fresh.bookedSeats}`);
});

await check('a passenger may request again after cancelling', async () => {
  const r = await publishRide(2);
  const first = await bookingService.createBooking({
    rideId: r.rideId, userId: alice, payload: bookingPayload(1),
  });
  await bookingService.cancelBookingByPassenger({ bookingId: first.bookingId, userId: alice });
  await bookingService.createBooking({ rideId: r.rideId, userId: alice, payload: bookingPayload(1) });
});

console.log('\nAUTHORIZATION (§43)');

await check('only the host sees the request list', async () => {
  const r = await publishRide(2);
  await bookingService.createBooking({ rideId: r.rideId, userId: alice, payload: bookingPayload(1) });
  const asHost = await bookingService.listRideRequests({ rideId: r.rideId, userId: host });
  if (asHost.length !== 1) throw new Error(`host should see 1, saw ${asHost.length}`);

  try {
    await bookingService.listRideRequests({ rideId: r.rideId, userId: bob });
  } catch (error) {
    if (error.code !== 'UNAUTHORIZED_RIDE_ACCESS') throw new Error(`got ${error.code}`);
    return;
  }
  throw new Error('a stranger should not read the request list');
});

await expectReject('an uninvolved user cannot read a booking', 'BOOKING_NOT_FOUND', () =>
  bookingService.getBooking({ bookingId: aliceBooking.bookingId, userId: bob }));

await expectReject('only the host can accept', 'UNAUTHORIZED_RIDE_ACCESS', () =>
  bookingService.acceptBooking({ bookingId: aliceBooking.bookingId, userId: bob }));

await expectReject('a booking cannot be accepted twice', 'BOOKING_ALREADY_PROCESSED', async () => {
  const r = await publishRide(2);
  const booking = await bookingService.createBooking({
    rideId: r.rideId, userId: bob, payload: bookingPayload(1),
  });
  await bookingService.acceptBooking({ bookingId: booking.bookingId, userId: host });
  return bookingService.acceptBooking({ bookingId: booking.bookingId, userId: host });
});

console.log('\nRIDE LIFECYCLE');

await check('cancelling a ride cancels its bookings and frees the seats', async () => {
  const r = await publishRide(2);
  const booking = await bookingService.createBooking({
    rideId: r.rideId, userId: alice, payload: bookingPayload(1),
  });
  await bookingService.acceptBooking({ bookingId: booking.bookingId, userId: host });

  const result = await bookingService.cancelRide({ rideId: r.rideId, userId: host, reason: 'car trouble' });
  if (result.cancelledBookings !== 1) throw new Error(`expected 1, got ${result.cancelledBookings}`);

  const detail = await bookingService.getBooking({ bookingId: booking.bookingId, userId: alice });
  if (detail.status !== 'CANCELLED') throw new Error(`booking is ${detail.status}`);
  if (detail.cancelledBy !== 'driver') throw new Error('cancelledBy should record the host');
});

await check('starting a ride declines requests still pending', async () => {
  const r = await publishRide(2);
  const accepted = await bookingService.createBooking({
    rideId: r.rideId, userId: alice, payload: bookingPayload(1),
  });
  const stranded = await bookingService.createBooking({
    rideId: r.rideId, userId: bob, payload: bookingPayload(1),
  });
  await bookingService.acceptBooking({ bookingId: accepted.bookingId, userId: host });

  await bookingService.startRide({ rideId: r.rideId, userId: host });

  const left = await bookingService.getBooking({ bookingId: stranded.bookingId, userId: bob });
  if (left.status !== 'REJECTED') throw new Error(`pending request is ${left.status}`);
});

await check('completing a ride completes its accepted bookings', async () => {
  const r = await publishRide(2);
  const booking = await bookingService.createBooking({
    rideId: r.rideId, userId: carol, payload: bookingPayload(1),
  });
  await bookingService.acceptBooking({ bookingId: booking.bookingId, userId: host });
  await bookingService.startRide({ rideId: r.rideId, userId: host });

  const result = await bookingService.completeRide({ rideId: r.rideId, userId: host });
  if (result.completedBookings !== 1) throw new Error(`expected 1, got ${result.completedBookings}`);

  const detail = await bookingService.getBooking({ bookingId: booking.bookingId, userId: carol });
  if (detail.status !== 'COMPLETED') throw new Error(`booking is ${detail.status}`);
});

await expectReject('a ride cannot be completed before it starts', 'RIDE_NOT_AVAILABLE', async () => {
  const r = await publishRide(2);
  return bookingService.completeRide({ rideId: r.rideId, userId: host });
});

await expectReject('a cancelled ride cannot be booked', 'RIDE_NOT_AVAILABLE', async () => {
  const r = await publishRide(2);
  await bookingService.cancelRide({ rideId: r.rideId, userId: host });
  return bookingService.createBooking({ rideId: r.rideId, userId: alice, payload: bookingPayload(1) });
});

console.log('\nDATA INTEGRITY (§47)');

await check('bookedSeats never goes negative under repeated cancellation', async () => {
  const r = await publishRide(1);
  const booking = await bookingService.createBooking({
    rideId: r.rideId, userId: alice, payload: bookingPayload(1),
  });
  await bookingService.acceptBooking({ bookingId: booking.bookingId, userId: host });
  await bookingService.cancelBookingByPassenger({ bookingId: booking.bookingId, userId: alice });

  await bookingService
    .cancelBookingByPassenger({ bookingId: booking.bookingId, userId: alice })
    .catch(() => null);

  const fresh = await CarpoolRide.findById(r.rideId);
  if (fresh.bookedSeats < 0) throw new Error(`negative seats: ${fresh.bookedSeats}`);
});

console.log(`\n${pass} passed, ${fail} failed`);

await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
