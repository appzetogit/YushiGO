/**
 * API-level tests for the Student Ride and Carpool modules.
 *
 *   node tests/api/http.mjs
 *
 * These drive the real Express app over HTTP on an ephemeral port: routing,
 * auth middleware, controllers, status codes and response envelopes all
 * participate. The service-level suites cover business rules; this one covers
 * everything between the socket and the service, which they cannot see —
 * a handler wired to the wrong path or a route shadowed by a parameter route
 * passes every service test and still 404s in the app.
 */
import http from 'node:http';
import mongoose from 'mongoose';

const DB_NAME = `api_test_${Date.now()}`;
process.env.MONGODB_URI = process.env.API_TEST_URI
  || `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'api-test-secret';
process.env.NODE_ENV = 'test';
process.env.CARPOOL_INSTANT_BOOKING = 'false';

const { createApp } = await import('../../src/app.js');
const { signAccessToken } = await import('../../src/modules/taxi/services/tokenService.js');

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

for (const name of [
  'TaxiCarpoolVehicle', 'TaxiCarpoolRide', 'TaxiCarpoolBooking',
  'TaxiCarpoolRating', 'TaxiCarpoolUserStats',
  'TaxiStudent', 'TaxiStudentGuardian', 'TaxiStudentSavedLocation',
]) {
  await mongoose.model(name).createCollection();
  await mongoose.model(name).syncIndexes();
}

// The auth middleware loads the account behind the token, so these must exist.
const hostId = new mongoose.Types.ObjectId();
const riderId = new mongoose.Types.ObjectId();
const outsiderId = new mongoose.Types.ObjectId();

await mongoose.connection.collection('taxiusers').insertMany([
  { _id: hostId, name: 'Varun', phone: '9000000001', active: true },
  { _id: riderId, name: 'Aarohi', phone: '9000000002', active: true },
  { _id: outsiderId, name: 'Stranger', phone: '9000000003', active: true },
]);

const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;

const tokenFor = (sub) => signAccessToken({ sub: String(sub), role: 'user' });
const hostToken = tokenFor(hostId);
const riderToken = tokenFor(riderId);
const outsiderToken = tokenFor(outsiderId);

const call = async (method, path, { token, body } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return { status: response.status, body: payload };
};

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

const expectStatus = async (name, expected, method, path, options = {}) => {
  await check(name, async () => {
    const { status, body } = await call(method, path, options);

    if (status !== expected) {
      throw new Error(`expected ${expected}, got ${status} (${body?.message || 'no message'})`);
    }

    if (options.code && body?.code !== options.code) {
      throw new Error(`expected code ${options.code}, got ${body?.code}`);
    }
  });
};

console.log('\nAUTHENTICATION');

await expectStatus('carpool rejects a missing token', 401, 'GET', '/carpool/vehicles');
await expectStatus('student ride rejects a missing token', 401, 'GET', '/student-ride/students');
await expectStatus('a malformed token is rejected', 401, 'GET', '/carpool/vehicles', { token: 'not-a-jwt' });

await check('a token for a deleted account is rejected', async () => {
  const ghost = new mongoose.Types.ObjectId();
  const { status } = await call('GET', '/carpool/vehicles', { token: tokenFor(ghost) });
  if (status !== 401) throw new Error(`expected 401, got ${status}`);
});

await expectStatus('an unknown route 404s', 404, 'GET', '/carpool/does-not-exist', { token: hostToken });

console.log('\nRESPONSE ENVELOPE');

await check('success responses use { success, data }', async () => {
  const { status, body } = await call('GET', '/carpool/vehicles', { token: hostToken });
  if (status !== 200) throw new Error(`status ${status}`);
  if (body?.success !== true) throw new Error('success flag missing');
  if (!Array.isArray(body?.data?.vehicles)) throw new Error('data.vehicles missing');
});

await check('error responses carry a stable code alongside the message', async () => {
  const { status, body } = await call('POST', '/student-ride/students', {
    token: riderToken,
    body: { name: 'Aarohi', dateOfBirth: '2014-08-12' },
  });
  if (status !== 422) throw new Error(`status ${status}`);
  if (body?.code !== 'GUARDIAN_REQUIRED') throw new Error(`code was ${body?.code}`);
  if (!body?.message) throw new Error('message missing');
});

console.log('\nROUTE ORDERING');

await check('/carpool/rides/search is not swallowed by /carpool/rides/:rideId', async () => {
  const { status, body } = await call(
    'GET',
    '/carpool/rides/search?from_lat=22.71&from_lng=75.85&to_lat=23.17&to_lng=75.78',
    { token: riderToken },
  );
  // A shadowed route would try to cast "search" to an ObjectId and 404.
  if (status !== 200) throw new Error(`expected 200, got ${status} (${body?.message})`);
  if (!Array.isArray(body?.data?.rides)) throw new Error('rides array missing');
});

await check('/carpool/my-offered-rides is not treated as a ride id', async () => {
  const { status } = await call('GET', '/carpool/my-offered-rides', { token: hostToken });
  if (status !== 200) throw new Error(`expected 200, got ${status}`);
});

await check('/student-ride/students/:id still resolves a real id path', async () => {
  const { status, body } = await call('GET', '/student-ride/students/not-an-id', { token: riderToken });
  if (status !== 404) throw new Error(`expected 404, got ${status}`);
  if (body?.code !== 'STUDENT_NOT_FOUND') throw new Error(`code ${body?.code}`);
});

console.log('\nCARPOOL FLOW OVER HTTP');

let vehicleId;
let rideId;
let bookingId;

await check('POST /carpool/vehicles returns 201 and the vehicle', async () => {
  const { status, body } = await call('POST', '/carpool/vehicles', {
    token: hostToken,
    body: { model: 'Hyundai i20', registrationNumber: 'MP09AB4321', seatCapacity: 4 },
  });
  if (status !== 201) throw new Error(`expected 201, got ${status} (${body?.message})`);
  vehicleId = body.data.vehicle.id;
  if (!vehicleId) throw new Error('vehicle id missing');
});

await check('a vehicle response never exposes stored documents', async () => {
  const { body } = await call('GET', '/carpool/vehicles', { token: hostToken });
  const [vehicle] = body.data.vehicles;
  if ('documents' in vehicle) throw new Error('documents leaked');
});

await check('POST /carpool/rides publishes and returns 201', async () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const { status, body } = await call('POST', '/carpool/rides', {
    token: hostToken,
    body: {
      vehicle_id: vehicleId,
      origin: { name: 'Indore', lat: 22.7196, lng: 75.8577 },
      destination: { name: 'Ujjain', lat: 23.1765, lng: 75.7885 },
      pickup: { name: 'Indore', lat: 22.7196, lng: 75.8577 },
      drop: { name: 'Ujjain', lat: 23.1765, lng: 75.7885 },
      stops: [{ name: 'Dewas', lat: 22.9676, lng: 76.0534, order: 1 }],
      date: tomorrow,
      departure_time: '10:30',
      available_seats: 2,
      price_per_seat: 180,
    },
  });
  if (status !== 201) throw new Error(`expected 201, got ${status} (${body?.message})`);
  rideId = body.data.rideId;
  if (body.message !== 'Ride published successfully') throw new Error('message copy changed');
});

await check('search returns the published ride with match detail', async () => {
  const { body } = await call(
    'GET',
    '/carpool/rides/search?from_lat=22.9676&from_lng=76.0534&to_lat=23.1765&to_lng=75.7885',
    { token: riderToken },
  );
  const found = body.data.rides.find((row) => row.rideId === rideId);
  if (!found) throw new Error('published ride not returned');
  if (!found.match) throw new Error('match detail missing');
  if (found.vehicle?.registrationNumber) throw new Error('plate exposed to searchers');
});

await check('a host does not see their own ride in search', async () => {
  const { body } = await call(
    'GET',
    '/carpool/rides/search?from_lat=22.9676&from_lng=76.0534&to_lat=23.1765&to_lng=75.7885',
    { token: hostToken },
  );
  if (body.data.rides.some((row) => row.rideId === rideId)) {
    throw new Error('host saw their own ride');
  }
});

await check('GET a ride shows isOwner true for the host, false for others', async () => {
  const asHost = await call('GET', `/carpool/rides/${rideId}`, { token: hostToken });
  const asRider = await call('GET', `/carpool/rides/${rideId}`, { token: riderToken });

  if (asHost.body.data.isOwner !== true) throw new Error('host should own it');
  if (asRider.body.data.isOwner !== false) throw new Error('rider should not own it');
  if (asRider.body.data.vehicle?.registrationNumber) throw new Error('plate exposed on detail');
});

await check('POST a booking returns 201 and PENDING', async () => {
  const { status, body } = await call('POST', `/carpool/rides/${rideId}/bookings`, {
    token: riderToken,
    body: {
      seat_count: 1,
      pickup: { name: 'Dewas', lat: 22.9676, lng: 76.0534 },
      drop: { name: 'Ujjain', lat: 23.1765, lng: 75.7885 },
    },
  });
  if (status !== 201) throw new Error(`expected 201, got ${status} (${body?.message})`);
  bookingId = body.data.bookingId;
  if (body.data.status !== 'PENDING') throw new Error(`status ${body.data.status}`);
});

await check('a repeat booking is refused while one is open', async () => {
  const { status, body } = await call('POST', `/carpool/rides/${rideId}/bookings`, {
    token: riderToken,
    body: {
      seat_count: 1,
      pickup: { name: 'Dewas', lat: 22.9676, lng: 76.0534 },
      drop: { name: 'Ujjain', lat: 23.1765, lng: 75.7885 },
    },
  });
  if (status !== 409) throw new Error(`expected 409, got ${status}`);
  if (body?.code !== 'DUPLICATE_BOOKING') throw new Error(`code ${body?.code}`);
});

console.log('\nAUTHORIZATION OVER HTTP');

await check('an outsider cannot read the request list', async () => {
  const { status, body } = await call('GET', `/carpool/rides/${rideId}/requests`, { token: outsiderToken });
  if (status !== 403) throw new Error(`expected 403, got ${status}`);
  if (body?.code !== 'UNAUTHORIZED_RIDE_ACCESS') throw new Error(`code ${body?.code}`);
});

await check('an outsider cannot read someone else\'s booking', async () => {
  const { status, body } = await call('GET', `/carpool/bookings/${bookingId}`, { token: outsiderToken });
  // Reported as not found rather than forbidden, so ids cannot be probed.
  if (status !== 404) throw new Error(`expected 404, got ${status}`);
  if (body?.code !== 'BOOKING_NOT_FOUND') throw new Error(`code ${body?.code}`);
});

await check('an outsider cannot accept a booking', async () => {
  const { status } = await call('POST', `/carpool/bookings/${bookingId}/accept`, { token: outsiderToken });
  if (status !== 403) throw new Error(`expected 403, got ${status}`);
});

await check('the host accepts and the seat is taken', async () => {
  const { status, body } = await call('POST', `/carpool/bookings/${bookingId}/accept`, { token: hostToken });
  if (status !== 200) throw new Error(`expected 200, got ${status} (${body?.message})`);
  if (body.data.status !== 'ACCEPTED') throw new Error(`status ${body.data.status}`);

  const ride = await call('GET', `/carpool/rides/${rideId}`, { token: hostToken });
  if (ride.body.data.bookedSeats !== 1) throw new Error(`bookedSeats ${ride.body.data.bookedSeats}`);
});

await expectStatus('accepting twice is refused', 409, 'POST',
  `/carpool/bookings/${bookingId}/accept`, { token: hostToken, code: 'BOOKING_ALREADY_PROCESSED' });

console.log('\nLIFECYCLE AND RATING OVER HTTP');

await check('start then complete moves the ride and its booking', async () => {
  const started = await call('POST', `/carpool/rides/${rideId}/start`, { token: hostToken });
  if (started.status !== 200) throw new Error(`start: ${started.status}`);

  const completed = await call('POST', `/carpool/rides/${rideId}/complete`, { token: hostToken });
  if (completed.status !== 200) throw new Error(`complete: ${completed.status}`);
  if (completed.body.data.completedBookings !== 1) throw new Error('booking not completed');
});

await check('POST /carpool/ratings returns 201 with the derived target', async () => {
  const { status, body } = await call('POST', '/carpool/ratings', {
    token: riderToken,
    body: { booking_id: bookingId, rating: 5, review: 'Good and safe ride.' },
  });
  if (status !== 201) throw new Error(`expected 201, got ${status} (${body?.message})`);
  if (body.data.ratedUserId !== String(hostId)) throw new Error('rated the wrong person');
  if (body.data.raterRole !== 'passenger') throw new Error(`raterRole ${body.data.raterRole}`);
});

await expectStatus('rating the same trip twice is refused', 409, 'POST', '/carpool/ratings',
  { token: riderToken, body: { booking_id: bookingId, rating: 3 }, code: 'DUPLICATE_RATING' });

await check('GET /carpool/home summarises the account', async () => {
  const { status, body } = await call('GET', '/carpool/home', { token: hostToken });
  if (status !== 200) throw new Error(`status ${status}`);
  if (typeof body.data.upcoming_count !== 'number') throw new Error('upcoming_count missing');
  if (!body.data.stats?.asHost) throw new Error('stats missing');
});

await check('GET /carpool/my-trips separates the two roles', async () => {
  const { status, body } = await call('GET', '/carpool/my-trips?type=offered', { token: hostToken });
  if (status !== 200) throw new Error(`status ${status}`);
  if (!Array.isArray(body.data.offered_rides)) throw new Error('offered_rides missing');
  if (body.data.passenger_trips.length) throw new Error('type=offered returned bookings');
});

console.log('\nSTUDENT RIDE OVER HTTP');

let studentId;

await check('POST /student-ride/students creates with a guardian', async () => {
  const { status, body } = await call('POST', '/student-ride/students', {
    token: riderToken,
    body: {
      name: 'Aarohi Sharma',
      dateOfBirth: '2014-08-12',
      schoolName: "St. Teresa's",
      className: '8-A',
      guardians: [{ name: 'Varun', mobile: '9876543210', relationship: 'FATHER' }],
    },
  });
  if (status !== 201) throw new Error(`expected 201, got ${status} (${body?.message})`);
  studentId = body.data.student.id;
  if (body.data.student.age === undefined) throw new Error('derived age missing');
  if (body.data.student.isMinor !== true) throw new Error('isMinor missing');
});

await check('a client-sent age is ignored over HTTP too', async () => {
  const { body } = await call('POST', '/student-ride/students', {
    token: riderToken,
    body: {
      name: 'Fake Age', dateOfBirth: '2014-08-12', age: 45,
      guardians: [{ name: 'P', mobile: '9998887777', relationship: 'MOTHER' }],
    },
  });
  if (body.data.student.age === 45) throw new Error('client age was trusted');
});

await check("another user cannot read someone else's student", async () => {
  const { status, body } = await call('GET', `/student-ride/students/${studentId}`, { token: hostToken });
  if (status !== 404) throw new Error(`expected 404, got ${status}`);
  if (body?.code !== 'STUDENT_NOT_FOUND') throw new Error(`code ${body?.code}`);
});

await check('POST a saved location returns 201', async () => {
  const { status, body } = await call('POST', `/student-ride/students/${studentId}/locations`, {
    token: riderToken,
    body: { label: 'SCHOOL', address: 'Knowledge Park II', latitude: 28.46, longitude: 77.51 },
  });
  if (status !== 201) throw new Error(`expected 201, got ${status} (${body?.message})`);
  if (body.data.location.label !== 'SCHOOL') throw new Error('label not stored');
});

await expectStatus('an out-of-range latitude is refused', 422, 'POST',
  `/student-ride/students/${studentId}/locations`, {
    token: riderToken,
    body: { label: 'HOME', address: 'x', latitude: 999, longitude: 77 },
    code: 'INVALID_LOCATION',
  });

await check('DELETE deactivates rather than removing', async () => {
  const { status, body } = await call('DELETE', `/student-ride/students/${studentId}`, { token: riderToken });
  if (status !== 200) throw new Error(`status ${status}`);
  if (body.data.student.status !== 'INACTIVE') throw new Error('not deactivated');

  const still = await call('GET', `/student-ride/students/${studentId}`, { token: riderToken });
  if (still.status !== 200) throw new Error('deactivated student should still resolve');
});

console.log(`\n${pass} passed, ${fail} failed`);

await new Promise((resolve) => server.close(resolve));
await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
