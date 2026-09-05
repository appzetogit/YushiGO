/**
 * Carpool — ratings (§35/§36), reputation and trip summaries (§27).
 *
 *   node tests/carpool/rating.mjs
 */
import mongoose from 'mongoose';

const DB_NAME = `carpool_rating_${Date.now()}`;
process.env.MONGODB_URI = process.env.CARPOOL_TEST_URI
  || `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
process.env.CARPOOL_INSTANT_BOOKING = 'false';

const rideService = await import('../../src/modules/taxi/carpool/services/carpoolRideService.js');
const vehicleService = await import('../../src/modules/taxi/carpool/services/carpoolVehicleService.js');
const bookingService = await import('../../src/modules/taxi/carpool/services/carpoolBookingService.js');
const ratingService = await import('../../src/modules/taxi/carpool/services/carpoolRatingService.js');
const tripsService = await import('../../src/modules/taxi/carpool/services/carpoolTripsService.js');

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

for (const name of [
  'TaxiCarpoolVehicle', 'TaxiCarpoolRide', 'TaxiCarpoolBooking',
  'TaxiCarpoolRating', 'TaxiCarpoolUserStats',
]) {
  await mongoose.model(name).createCollection();
}
await mongoose.model('TaxiCarpoolRating').syncIndexes();
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
const stranger = new mongoose.Types.ObjectId();

const INDORE = { name: 'Indore', lat: 22.7196, lng: 75.8577 };
const UJJAIN = { name: 'Ujjain', lat: 23.1765, lng: 75.7885 };
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

const vehicle = await vehicleService.createVehicle({
  userId: host,
  payload: { model: 'Hyundai i20', registrationNumber: 'MP09ZZ9999', seatCapacity: 4 },
});

/** Publish, book, accept, start, complete — a whole trip. */
const completedTrip = async (passenger = alice) => {
  const ride = await rideService.createRide({
    userId: host,
    payload: {
      vehicle_id: vehicle.id, origin: INDORE, destination: UJJAIN, pickup: INDORE, drop: UJJAIN,
      date: tomorrow, departure_time: '10:30', available_seats: 3, price_per_seat: 180,
    },
  });
  const booking = await bookingService.createBooking({
    rideId: ride.rideId, userId: passenger,
    payload: { seat_count: 1, pickup: INDORE, drop: UJJAIN },
  });
  await bookingService.acceptBooking({ bookingId: booking.bookingId, userId: host });
  await bookingService.startRide({ rideId: ride.rideId, userId: host });
  await bookingService.completeRide({ rideId: ride.rideId, userId: host });

  return { ride, booking };
};

console.log('\nRATING RULES (§35)');

const openTrip = await (async () => {
  const ride = await rideService.createRide({
    userId: host,
    payload: {
      vehicle_id: vehicle.id, origin: INDORE, destination: UJJAIN, pickup: INDORE, drop: UJJAIN,
      date: tomorrow, departure_time: '11:30', available_seats: 3, price_per_seat: 180,
    },
  });
  const booking = await bookingService.createBooking({
    rideId: ride.rideId, userId: alice,
    payload: { seat_count: 1, pickup: INDORE, drop: UJJAIN },
  });
  return { ride, booking };
})();

await expectReject('an incomplete trip cannot be rated', 'RATING_NOT_ALLOWED', () =>
  ratingService.createRating({ userId: alice, payload: { booking_id: openTrip.booking.bookingId, rating: 5 } }));

const trip = await completedTrip();

await expectReject('a rating outside 1-5 is refused', 'RATING_NOT_ALLOWED', () =>
  ratingService.createRating({ userId: alice, payload: { booking_id: trip.booking.bookingId, rating: 9 } }));

await expectReject('someone outside the trip cannot rate it', 'BOOKING_NOT_FOUND', () =>
  ratingService.createRating({ userId: stranger, payload: { booking_id: trip.booking.bookingId, rating: 5 } }));

await check('passenger rates the host', async () => {
  const rating = await ratingService.createRating({
    userId: alice,
    payload: { booking_id: trip.booking.bookingId, rating: 5, review: 'Good and safe ride.' },
  });
  if (rating.raterRole !== 'passenger') throw new Error(`raterRole is ${rating.raterRole}`);
  if (rating.ratedUserId !== String(host)) throw new Error('rated the wrong person');
});

await expectReject('the same person cannot rate the same trip twice', 'DUPLICATE_RATING', () =>
  ratingService.createRating({ userId: alice, payload: { booking_id: trip.booking.bookingId, rating: 3 } }));

await check('the host rates the passenger on the same trip', async () => {
  const rating = await ratingService.createRating({
    userId: host,
    payload: { booking_id: trip.booking.bookingId, rating: 4 },
  });
  if (rating.raterRole !== 'host') throw new Error(`raterRole is ${rating.raterRole}`);
  if (rating.ratedUserId !== String(alice)) throw new Error('rated the wrong person');
});

await check('a rated_user_id in the body is ignored', async () => {
  const second = await completedTrip();
  const rating = await ratingService.createRating({
    userId: alice,
    payload: { booking_id: second.booking.bookingId, rating: 5, rated_user_id: String(stranger) },
  });
  // The counterparty comes from the booking, so a forged target cannot land.
  if (rating.ratedUserId !== String(host)) throw new Error('client-supplied target was trusted');
});

console.log('\nDIRECTION (§36)');

await check('host and passenger reputations are kept apart', async () => {
  const hostStats = await ratingService.getUserStats(host);
  const aliceStats = await ratingService.getUserStats(alice);

  // Host was rated 5 and 5 as a host; nobody has rated them as a passenger.
  if (hostStats.asHost.ratingCount !== 2) throw new Error(`host ratings: ${hostStats.asHost.ratingCount}`);
  if (hostStats.asHost.rating !== 5) throw new Error(`host average: ${hostStats.asHost.rating}`);
  if (hostStats.asPassenger.ratingCount !== 0) throw new Error('host should have no passenger ratings');

  // Alice was rated 4 as a passenger, and has no host ratings at all.
  if (aliceStats.asPassenger.ratingCount !== 1) throw new Error(`alice passenger ratings: ${aliceStats.asPassenger.ratingCount}`);
  if (aliceStats.asHost.ratingCount !== 0) throw new Error('alice should have no host ratings');
});

await check('the average reflects every rating, not just the last', async () => {
  const third = await completedTrip();
  await ratingService.createRating({
    userId: alice, payload: { booking_id: third.booking.bookingId, rating: 2 },
  });

  const stats = await ratingService.getUserStats(host);
  // 5, 5, 2 -> 4.0
  if (stats.asHost.rating !== 4) throw new Error(`expected 4, got ${stats.asHost.rating}`);
});

console.log('\nTRIP COUNTS');

await check('completing a ride counts a trip for both parties', async () => {
  const before = await ratingService.getUserStats(host);
  await completedTrip();
  const after = await ratingService.getUserStats(host);

  if (after.asHost.trips !== before.asHost.trips + 1) {
    throw new Error(`trips went ${before.asHost.trips} -> ${after.asHost.trips}`);
  }
});

await check('a trip counts even when nobody rates it', async () => {
  const passenger = new mongoose.Types.ObjectId();
  await completedTrip(passenger);
  const stats = await ratingService.getUserStats(passenger);

  if (stats.asPassenger.trips !== 1) throw new Error(`expected 1 trip, got ${stats.asPassenger.trips}`);
  if (stats.asPassenger.ratingCount !== 0) throw new Error('should have no ratings');
});

console.log('\nPENDING PROMPTS');

await check('a completed unrated trip is offered for rating', async () => {
  const passenger = new mongoose.Types.ObjectId();
  const fresh = await completedTrip(passenger);
  const pending = await ratingService.listRatableBookings({ userId: passenger });

  if (!pending.some((row) => row.bookingId === fresh.booking.bookingId)) {
    throw new Error('completed trip missing from pending list');
  }
  if (pending[0].role !== 'passenger') throw new Error(`role is ${pending[0].role}`);
});

await check('a rated trip drops off the pending list', async () => {
  const passenger = new mongoose.Types.ObjectId();
  const fresh = await completedTrip(passenger);
  await ratingService.createRating({
    userId: passenger, payload: { booking_id: fresh.booking.bookingId, rating: 5 },
  });

  const pending = await ratingService.listRatableBookings({ userId: passenger });
  if (pending.some((row) => row.bookingId === fresh.booking.bookingId)) {
    throw new Error('rated trip still listed');
  }
});

console.log('\nSEARCH AND TRIPS');

await check('search shows the host reputation', async () => {
  const searcher = new mongoose.Types.ObjectId();
  const results = await rideService.searchRides({
    userId: searcher,
    query: { from_lat: 22.7196, from_lng: 75.8577, to_lat: 23.1765, to_lng: 75.7885 },
  });

  if (!results.length) throw new Error('expected at least one match');
  if (results[0].host?.rating === undefined) throw new Error('host rating missing');
  if (!(results[0].host.totalTrips > 0)) throw new Error('host trip count missing');
});

await check('my-trips separates hosting from riding', async () => {
  const asHost = await tripsService.getMyTrips({ userId: host, type: 'offered' });
  const asPassenger = await tripsService.getMyTrips({ userId: alice, type: 'passenger' });

  if (!asHost.offered_rides.length) throw new Error('host should have offered rides');
  if (asHost.passenger_trips.length) throw new Error('type=offered should not return bookings');
  if (!asPassenger.passenger_trips.length) throw new Error('alice should have passenger trips');
  if (asPassenger.offered_rides.length) throw new Error('type=passenger should not return rides');
});

await check('the same account appears as host and passenger simultaneously (§4)', async () => {
  // The host books a seat on someone else's ride.
  const otherHost = new mongoose.Types.ObjectId();
  const otherVehicle = await vehicleService.createVehicle({
    userId: otherHost,
    payload: { model: 'Swift', registrationNumber: 'MP09QQ1111', seatCapacity: 4 },
  });
  const ride = await rideService.createRide({
    userId: otherHost,
    payload: {
      vehicle_id: otherVehicle.id, origin: UJJAIN, destination: INDORE, pickup: UJJAIN, drop: INDORE,
      date: tomorrow, departure_time: '18:00', available_seats: 2, price_per_seat: 150,
    },
  });
  await bookingService.createBooking({
    rideId: ride.rideId, userId: host,
    payload: { seat_count: 1, pickup: UJJAIN, drop: INDORE },
  });

  const trips = await tripsService.getMyTrips({ userId: host, type: 'all' });
  if (!trips.offered_rides.length) throw new Error('should still have offered rides');
  if (!trips.passenger_trips.length) throw new Error('should also have a passenger booking');
});

await check('home summarises both sides', async () => {
  const home = await tripsService.getCarpoolHome({ userId: host });
  if (typeof home.upcoming_count !== 'number') throw new Error('upcoming_count missing');
  if (!(home.completed_count > 0)) throw new Error('completed_count should be positive');
  if (!home.stats?.asHost) throw new Error('stats missing');
});

console.log(`\n${pass} passed, ${fail} failed`);

await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
