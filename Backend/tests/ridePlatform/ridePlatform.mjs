/**
 * Ride platform points from the app team: vehicle categories and luggage, trip
 * details on bookings, ghost-driver sweep, and the REST ride-offer accept/reject.
 *
 *   node tests/ridePlatform/ridePlatform.mjs
 *
 * Runs against a throwaway database (RIDE_PLATFORM_TEST_URI or a local rs0).
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const DB_NAME = `ride_platform_${Date.now()}`;
const baseUri = process.env.RIDE_PLATFORM_TEST_URI || process.env.DRIVER_HIRE_TEST_URI;
process.env.MONGODB_URI = baseUri
  ? baseUri.replace(/\/(\?|$)/, `/${DB_NAME}$1`)
  : `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ride-platform-secret';
process.env.NODE_ENV = 'test';
process.env.DRIVER_PRESENCE_TIMEOUT_SECONDS = '300';

const { createApp } = await import('../../src/app.js');
const { signAccessToken } = await import('../../src/modules/taxi/services/tokenService.js');
const { Vehicle } = await import('../../src/modules/taxi/admin/models/Vehicle.js');
const { Driver } = await import('../../src/modules/taxi/driver/models/Driver.js');
const { Ride } = await import('../../src/modules/taxi/user/models/Ride.js');
const adminService = await import('../../src/modules/taxi/admin/services/adminService.js');
const { normalizeTripDetails } = await import('../../src/modules/taxi/services/rideService.js');
const { sweepGhostDrivers } = await import('../../src/modules/taxi/driver/services/driverPresenceService.js');
const { migrateVehicleCategories } = await import('../../scripts/migrateVehicleCategories.js');

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
for (const model of [Vehicle, Driver, Ride]) await model.createCollection();

let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.stack || error.message}`);
    process.exitCode = 1;
  }
};
const rejects = async (fn, pattern) => {
  await assert.rejects(fn, (error) => {
    assert.match(String(error.message), pattern);
    return true;
  });
};

console.log('vehicle categories and luggage');

const sedan = await adminService.createVehicleType({
  name: 'YushiGo Fast', transport_type: 'taxi', icon_types: 'car', category: 'car', capacity: 4, luggage_capacity: 2,
});
const luxury = await adminService.createVehicleType({
  name: 'Mercedes E-Class', transport_type: 'taxi', icon_types: 'Luxary', category: 'luxury', capacity: 4, luggage_capacity: 3,
  short_description: 'Executive sedan',
});
const parcelBike = await Vehicle.create({ name: 'Go Parcel', transport_type: 'delivery', icon_types: 'bike', category: '', capacity: 10 });
const taxiBike = await Vehicle.create({
  name: 'Bike Go', transport_type: 'taxi', icon_types: 'bike', category: 'bike', capacity: 1,
  supported_other_vehicle_types: [parcelBike._id],
});

await check('old "car" category is stored as taxi', async () => {
  assert.equal((await Vehicle.findById(sedan._id).lean()).category, 'taxi');
});
await check('luggage capacity is saved', async () => {
  assert.equal((await Vehicle.findById(luxury._id).lean()).luggage_capacity, 3);
});
await check('an unknown category is refused', async () => {
  await rejects(() => adminService.createVehicleType({ name: 'X', transport_type: 'taxi', category: 'spaceship' }), /category must be one of/);
});
await check('updating category and luggage works', async () => {
  await adminService.updateVehicleType(String(sedan._id), { category: 'group', luggage_capacity: 6 });
  const saved = await Vehicle.findById(sedan._id).lean();
  assert.equal(saved.category, 'group');
  assert.equal(saved.luggage_capacity, 6);
  await adminService.updateVehicleType(String(sedan._id), { category: 'taxi', luggage_capacity: 2 });
});
await check('public catalog never returns a blank category', async () => {
  const { results } = await adminService.listPublicVehicleCatalog();
  const byName = Object.fromEntries(results.map((item) => [item.name, item]));
  assert.equal(byName['Go Parcel'].category, 'bike');
  assert.equal(byName['Mercedes E-Class'].category, 'luxury');
  assert.equal(byName['Mercedes E-Class'].luggage_capacity, 3);
  assert.ok(results.every((item) => item.category));
});
await check('migration fills blank and car categories, dry run first', async () => {
  await Vehicle.collection.insertOne({ name: 'Legacy Sedan', icon_types: 'car', category: 'car' });
  const dry = await migrateVehicleCategories();
  const names = dry.map((change) => `${change.name}:${change.to}`).sort();
  assert.deepEqual(names, ['Go Parcel:bike', 'Legacy Sedan:taxi']);
  assert.equal((await Vehicle.collection.findOne({ name: 'Legacy Sedan' })).category, 'car');
  await migrateVehicleCategories({ apply: true });
  assert.equal((await Vehicle.collection.findOne({ name: 'Legacy Sedan' })).category, 'taxi');
  assert.equal((await Vehicle.findById(parcelBike._id).lean()).category, 'bike');
  assert.equal((await migrateVehicleCategories()).length, 0);
});

console.log('trip details');

const sedanDoc = await Vehicle.findById(sedan._id).lean();
await check('passengers, luggage and purpose are read', async () => {
  assert.deepEqual(normalizeTripDetails({ passengers: 3, luggage: 2, purpose: 'Airport' }, sedanDoc), { passengers: 3, luggage: 2, purpose: 'airport' });
});
await check('tripPurpose is accepted as the purpose key', async () => {
  assert.equal(normalizeTripDetails({ tripPurpose: 'wedding' }, sedanDoc).purpose, 'wedding');
});
await check('all fields are optional', async () => {
  assert.deepEqual(normalizeTripDetails({}, sedanDoc), { passengers: null, luggage: null, purpose: '' });
  assert.deepEqual(normalizeTripDetails(undefined, null), { passengers: null, luggage: null, purpose: '' });
});
await check('more passengers than seats is refused', async () => {
  await rejects(async () => normalizeTripDetails({ passengers: 5 }, sedanDoc), /seats 4/);
});
await check('more bags than the vehicle takes is refused', async () => {
  await rejects(async () => normalizeTripDetails({ luggage: 3 }, sedanDoc), /takes 2 bag/);
});
await check('an unknown purpose or a bad count is refused', async () => {
  await rejects(async () => normalizeTripDetails({ purpose: 'holiday' }, sedanDoc), /tripPurpose must be one of/);
  await rejects(async () => normalizeTripDetails({ passengers: 0 }, sedanDoc), /passengers must be/);
  await rejects(async () => normalizeTripDetails({ luggage: 1.5 }, sedanDoc), /luggage must be/);
});
await check('a parcel vehicle\'s capacity is not a seat limit', async () => {
  const parcelDoc = await Vehicle.findById(parcelBike._id).lean();
  assert.equal(normalizeTripDetails({ passengers: 1 }, { ...parcelDoc, capacity: 0 }).passengers, 1);
});

console.log('ghost drivers');

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000);
const makeDriver = (overrides) => Driver.collection.insertOne({
  name: 'Driver', phone: `9${Math.floor(Math.random() * 1e9)}`, approve: true, status: 'approved', deletedAt: null,
  vehicleType: 'bike', isOnline: true, isOnRide: false, wallet: { balance: 1000, cashLimit: 500, isBlocked: false },
  ...overrides,
}).then((result) => result.insertedId);

const ghost = await makeDriver({ lastSeenAt: minutesAgo(20) });
const neverSeen = await makeDriver({ lastSeenAt: null });
const fresh = await makeDriver({ lastSeenAt: minutesAgo(1) });
const onRide = await makeDriver({ lastSeenAt: minutesAgo(30), isOnRide: true });
const offline = await makeDriver({ lastSeenAt: minutesAgo(30), isOnline: false });

await check('silent drivers go offline, live and on-ride drivers stay', async () => {
  const wentOffline = await sweepGhostDrivers();
  assert.deepEqual(wentOffline.sort(), [String(ghost), String(neverSeen)].sort());
  const state = async (id) => (await Driver.collection.findOne({ _id: id })).isOnline;
  assert.equal(await state(ghost), false);
  assert.equal(await state(neverSeen), false);
  assert.equal(await state(fresh), true);
  assert.equal(await state(onRide), true);
  assert.equal(await state(offline), false);
});
await check('a second sweep has nothing to do', async () => {
  assert.deepEqual(await sweepGhostDrivers(), []);
});

console.log('REST ride offers and heartbeat');

const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const call = async (method, path, token, body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const bikeDriver = await makeDriver({ vehicleTypeId: taxiBike._id, lastSeenAt: new Date() });
const parcelDriver = await makeDriver({ vehicleTypeId: parcelBike._id, lastSeenAt: new Date() });
const token = (id) => signAccessToken({ sub: String(id), role: 'driver' });
const userId = new mongoose.Types.ObjectId();
await mongoose.connection.collection('taxiusers').insertOne({ _id: userId, name: 'Riya', phone: '9000000009', active: true });

const makeRide = (vehicleTypeIds) => Ride.collection.insertOne({
  userId, status: 'searching', liveStatus: 'searching', driverId: null, bookingMode: 'normal', serviceType: 'ride',
  vehicleTypeId: vehicleTypeIds[0], dispatchVehicleTypeIds: vehicleTypeIds, fare: 120, paymentMethod: 'cash',
  pickupLocation: { type: 'Point', coordinates: [77.6, 12.9] }, dropLocation: { type: 'Point', coordinates: [77.7, 12.95] },
  otp: '1234', createdAt: new Date(), updatedAt: new Date(),
}).then((result) => result.insertedId);

await check('accept and reject need a driver token', async () => {
  const rideId = new mongoose.Types.ObjectId();
  assert.equal((await call('POST', `/drivers/ride-offers/${rideId}/accept`)).status, 401);
  assert.equal((await call('POST', `/drivers/ride-offers/${rideId}/reject`)).status, 401);
});
await check('a malformed ride id is a 400', async () => {
  assert.equal((await call('POST', '/drivers/ride-offers/not-an-id/accept', token(bikeDriver))).status, 400);
});
await check('reject answers 200', async () => {
  const rideId = await makeRide([taxiBike._id]);
  const result = await call('POST', `/drivers/ride-offers/${rideId}/reject`, token(bikeDriver));
  assert.equal(result.status, 200);
  assert.equal(result.body.data.rejected, true);
});
await check('accept assigns the ride, a second accept gets 409', async () => {
  const rideId = await makeRide([taxiBike._id]);
  const first = await call('POST', `/drivers/ride-offers/${rideId}/accept`, token(bikeDriver));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.rideId, String(rideId));
  const ride = await Ride.collection.findOne({ _id: rideId });
  assert.equal(String(ride.driverId), String(bikeDriver));
  const second = await call('POST', `/drivers/ride-offers/${rideId}/accept`, token(parcelDriver));
  assert.equal(second.status, 409);
});
await check('a driver of a supported type can accept the family ride', async () => {
  // What createRideRecord now stores for a "Bike Go" ride: its own type plus the supported one.
  const rideId = await makeRide([taxiBike._id, parcelBike._id]);
  const result = await call('POST', `/drivers/ride-offers/${rideId}/accept`, token(parcelDriver));
  assert.equal(result.status, 200, JSON.stringify(result.body));
});
await check('an inactive driver cannot accept', async () => {
  const inactive = await makeDriver({ vehicleTypeId: taxiBike._id, status: 'inactive', lastSeenAt: new Date() });
  const rideId = await makeRide([taxiBike._id]);
  assert.equal((await call('POST', `/drivers/ride-offers/${rideId}/accept`, token(inactive))).status, 409);
});
await check('heartbeat refreshes lastSeenAt and can move the driver', async () => {
  await Driver.collection.updateOne({ _id: fresh }, { $set: { lastSeenAt: minutesAgo(10) } });
  const result = await call('POST', '/drivers/heartbeat', token(fresh), { location: [77.59, 12.97] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.isOnline, true);
  const saved = await Driver.collection.findOne({ _id: fresh });
  assert.ok(Date.now() - saved.lastSeenAt.getTime() < 10000);
  assert.deepEqual(saved.location.coordinates, [77.59, 12.97]);
});

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${passed} checks passed${process.exitCode ? ', some FAILED' : ''}`);
