/**
 * Group & Large Vehicles — seed script + HTTP contract.
 *
 *   GROUP_TRAVEL_TEST_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0 node tests/groupTravel/http.mjs
 *
 * Runs scripts/seedGroupVehicles.js against a throwaway database, then drives the
 * real Express app: /schedules, /schedules/:id/availability and /search/vehicles.
 */
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_NAME = `group_travel_api_${Date.now()}`;
process.env.MONGODB_URI = process.env.GROUP_TRAVEL_TEST_URI
  ? process.env.GROUP_TRAVEL_TEST_URI.replace(/\/(\?|$)/, `/${DB_NAME}$1`)
  : `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'api-test-secret';
process.env.NODE_ENV = 'test';
process.env.DRIVER_HIRE_SWEEP_ENABLED = 'false';

const { createApp } = await import('../../src/app.js');
const { signAccessToken } = await import('../../src/modules/taxi/services/tokenService.js');

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

const userId = new mongoose.Types.ObjectId();
await mongoose.connection.collection('taxiusers').insertOne({ _id: userId, name: 'Asha', phone: '9000000011', active: true });
await mongoose.connection.collection('taxiadminbusinesssettings').insertOne({
  scope: 'default',
  transport_ride: { enable_bus_service: '1' },
});

const runSeed = (...args) =>
  execFileSync(process.execPath, ['scripts/seedGroupVehicles.js', ...args], {
    cwd: rootDir,
    env: process.env,
    encoding: 'utf8',
  });

console.log('seed without zones');
runSeed('--apply');
check('global price per vehicle when there are no zones', (await mongoose.connection.collection('taxisetprices').countDocuments({ zone_id: null })) === 7);
for (const name of ['taxivehicles', 'taxisetprices', 'taxibusservices']) {
  await mongoose.connection.collection(name).deleteMany({});
}
await mongoose.connection.collection('taxizones').insertMany([
  { name: 'Indore', active: true, status: 'active' },
  { name: 'Legacy zone', active: true }, // no status field, as older zones are stored
  { name: 'Closed zone', active: true, status: 'inactive' },
]);

console.log('seed');
const dryRun = runSeed();
check('dry run writes nothing', (await mongoose.connection.collection('taxibusservices').countDocuments()) === 0, dryRun);
runSeed('--apply');
const secondRun = runSeed('--apply');
check('re-run keeps existing records', !/create /.test(secondRun), secondRun);
check('7 group vehicle types', (await mongoose.connection.collection('taxivehicles').countDocuments({ category: 'group' })) === 7);
check('7 group trips', (await mongoose.connection.collection('taxibusservices').countDocuments({ vehicleKind: { $ne: 'bus' } })) === 7);
check('prices in usable zones only', (await mongoose.connection.collection('taxisetprices').countDocuments()) === 14);

const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const token = signAccessToken({ sub: String(userId), role: 'user' });

const call = async (method, url, body) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

// Next Saturday: every seeded trip except the weekday-only Mumbai-Pune Luxury Van runs (9 schedules).
const saturday = new Date();
saturday.setDate(saturday.getDate() + ((6 - saturday.getDay() + 7) % 7 || 7));
const date = saturday.toISOString().slice(0, 10);

console.log('GET /schedules');
const unauthorized = await fetch(`${base}/schedules`);
check('requires login', unauthorized.status === 401);
const all = await call('GET', `/schedules?date=${date}`);
check('lists group trips on the date', all.status === 200 && all.body.data.schedules.length === 9, JSON.stringify(all.body).slice(0, 200));
const route = await call('GET', `/schedules?origin=indore&destination=ujjain&date=${date}`);
const urbania = route.body.data.schedules[0];
check('filters by route', route.body.data.schedules.length === 3 && urbania?.vehicleKind === 'urbania');
check('real fare and seats', urbania?.price === 299 && urbania?.totalSeats === 15 && urbania?.availableSeats === 15, JSON.stringify(urbania));
check('boarding points included', urbania?.route?.stops?.length === 3);
const byKind = await call('GET', `/schedules?vehicleKind=traveller,mini_bus&date=${date}`);
check('filters by vehicle kind', byKind.body.data.schedules.every((item) => ['traveller', 'mini_bus'].includes(item.vehicleKind)) && byKind.body.data.schedules.length === 3);
const stopMatch = await call('GET', `/schedules?origin=dewas&date=${date}`);
check('matches a boarding-point city', stopMatch.body.data.schedules.length === 2);

const legacyBus = (await mongoose.connection.collection('taxibusservices').findOne({ serviceNumber: 'YG-MB-DEL-AGR' }));
await mongoose.connection.collection('taxibusservices').insertOne({
  ...legacyBus,
  _id: new mongoose.Types.ObjectId(),
  serviceNumber: 'LEGACY-BUS',
  vehicleKind: undefined,
});
await mongoose.connection.collection('taxibusservices').updateOne({ serviceNumber: 'LEGACY-BUS' }, { $unset: { vehicleKind: '' } });
const buses = await call('GET', `/schedules?vehicleKind=bus&date=${date}`);
check('older services without a kind count as buses', buses.body.data.schedules.length === 1 && buses.body.data.schedules[0].vehicleKind === 'bus', JSON.stringify(buses.body).slice(0, 200));
await mongoose.connection.collection('taxibusservices').deleteOne({ serviceNumber: 'LEGACY-BUS' });

console.log('GET /schedules/:id/availability');
const availability = await call('GET', `/schedules/${urbania.id}/availability`);
check('seat map for the trip', availability.status === 200 && availability.body.data.totalSeats === 15 && availability.body.data.seats[0]?.seatId === 'S1A', JSON.stringify(availability.body).slice(0, 200));
await mongoose.connection.collection('taxibusseatholds').insertOne({
  busServiceId: new mongoose.Types.ObjectId(urbania.busServiceId),
  scheduleId: urbania.scheduleId,
  travelDate: date,
  seatId: 'S1A',
  status: 'booked',
  holdToken: 'test',
});
const afterHold = await call('GET', `/schedules/${urbania.busServiceId}/availability?scheduleId=${urbania.scheduleId}&date=${date}`);
check('held seat shows booked', afterHold.body.data.bookedSeats === 1 && afterHold.body.data.seats.find((seat) => seat.seatId === 'S1A')?.status === 'booked');
const otherSchedule = await call('GET', `/schedules/${urbania.busServiceId}/availability?scheduleId=urb-idr-ujn-1500&date=${date}`);
check('hold is per schedule', otherSchedule.body.data.bookedSeats === 0);
const listAfterHold = await call('GET', `/schedules?origin=indore&destination=ujjain&date=${date}`);
check('list count drops after hold', listAfterHold.body.data.schedules.find((item) => item.scheduleId === urbania.scheduleId)?.availableSeats === 14);
const badId = await call('GET', '/schedules/not-an-id/availability?scheduleId=x');
check('bad id is 400', badId.status === 400);
const wrongDay = await call('GET', `/schedules/${byKind.body.data.schedules.find((item) => item.vehicleKind === 'mini_bus').busServiceId}/availability?scheduleId=mb-del-agr-0600&date=${new Date(saturday.getTime() + 2 * 86400000).toISOString().slice(0, 10)}`);
check('trip not running that day is 404', wrongDay.status === 404);

console.log('POST /search/vehicles');
const search = await call('POST', '/search/vehicles', {
  origin: { lat: 22.7196, lng: 75.8577 },
  destination: { lat: 23.1765, lng: 75.7885 },
  passengers: 14,
});
const vehicles = search.body.data?.vehicles || [];
check('returns group vehicles', search.status === 200 && vehicles.length === 7, JSON.stringify(search.body).slice(0, 200));
const vans = await call('GET', `/schedules?vehicleKind=luxury_van&date=${date}`);
check('luxury van trips run on the weekend', vans.body.data.schedules.length === 4 && vans.body.data.schedules.every((item) => item.vehicleKind === 'luxury_van'), JSON.stringify(vans.body).slice(0, 200));
check('vehicles that fit come first', vehicles[0]?.fitsPassengers === true && vehicles[0]?.name === 'Force Urbania');
const urbaniaFare = vehicles.find((item) => item.name === 'Force Urbania')?.fare;
check('server-side fare from SetPrice', urbaniaFare?.total === 2500 + (51 - 10) * 32, JSON.stringify(urbaniaFare));
const noCoords = await call('POST', '/search/vehicles', { passengers: 4 });
check('needs coordinates or distance', noCoords.status === 400);

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(failures === 0 ? '\nall group travel checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
