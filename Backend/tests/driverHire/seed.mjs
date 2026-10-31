/**
 * Search a Driver — seed script and the event-packages endpoint.
 *
 *   DRIVER_HIRE_TEST_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0 node tests/driverHire/seed.mjs
 *
 * Runs scripts/seedDriverHire.js on a throwaway database, then quotes every
 * service type over HTTP against the seeded rules.
 */
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_NAME = `driver_hire_seed_${Date.now()}`;
process.env.MONGODB_URI = process.env.DRIVER_HIRE_TEST_URI
  ? process.env.DRIVER_HIRE_TEST_URI.replace(/\/(\?|$)/, `/${DB_NAME}$1`)
  : `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'api-test-secret';
process.env.NODE_ENV = 'test';
process.env.DRIVER_HIRE_SWEEP_ENABLED = 'false';

const { createApp } = await import('../../src/app.js');
const { signAccessToken } = await import('../../src/modules/taxi/services/tokenService.js');

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
for (const name of ['TaxiDriverHirePricing', 'TaxiDriverHireQuote', 'TaxiDriverHireAuditLog']) {
  await mongoose.model(name).createCollection().catch(() => {});
}
const db = mongoose.connection;
const customerId = new mongoose.Types.ObjectId();
await db.collection('taxiusers').insertOne({ _id: customerId, name: 'Riya', phone: '9000000002', active: true });
await db.collection('taxiappmodules').insertOne({ name: 'Taxi', transport_type: 'taxi', order_by: 1, active: 1 });

const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const token = signAccessToken({ sub: String(customerId), role: 'user' });
const call = async (method, url, body) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const runSeed = (...args) =>
  execFileSync(process.execPath, ['scripts/seedDriverHire.js', ...args], { cwd: rootDir, env: process.env, encoding: 'utf8' });

console.log('event packages before seeding');
const empty = await call('GET', '/driver-bookings/event-packages');
check('empty list, not an error, when event pricing is not set up', empty.status === 200 && empty.body.data.packages.length === 0, JSON.stringify(empty.body));
const notSwallowed = await call('GET', '/driver-bookings/event-packages');
check('not captured by /:bookingId', notSwallowed.body?.code !== 'BOOKING_NOT_FOUND');

console.log('seed');
const dry = runSeed();
check('dry run writes nothing', (await db.collection('taxidriverhirepricings').countDocuments()) === 0, dry);
runSeed('--apply');
const again = runSeed('--apply');
check('re-run changes nothing', !/publish |create /.test(again), again);
check('rules for all 5 service types', (await db.collection('taxidriverhirepricings').countDocuments({ current: true, serviceLocationId: null })) === 5);
check('published with an audit entry each', (await db.collection('taxidriverhireauditlogs').countDocuments({ action: 'PRICING_PUBLISHED' })) === 5);
check('home tile created once', (await db.collection('taxiappmodules').countDocuments({ name: 'Search a Driver' })) === 1);

console.log('event packages after seeding');
const packages = await call('GET', '/driver-bookings/event-packages');
check('lists the seeded packages', packages.body?.data?.packages?.map((p) => p.code).join() === 'HALF_DAY,FULL_DAY,WEDDING', JSON.stringify(packages.body));

console.log('quotes on the seeded rules');
const later = new Date(Date.now() + 3 * 86400000);
later.setHours(10, 0, 0, 0);
const pickup = { address: 'Vijay Nagar, Indore', latitude: 22.75, longitude: 75.89 };
const quote = (body) => call('POST', '/driver-bookings/quote', { pickup, ...body });
const results = {
  NOW: await quote({ serviceType: 'NOW', durationMinutes: 120 }),
  SCHEDULED: await quote({ serviceType: 'SCHEDULED', scheduledAt: later.toISOString(), durationMinutes: 180 }),
  HOURLY: await quote({ serviceType: 'HOURLY', scheduledAt: later.toISOString(), durationMinutes: 240 }),
  OUTSTATION: await quote({
    serviceType: 'OUTSTATION',
    scheduledAt: later.toISOString(),
    destination: { address: 'Bhopal', latitude: 23.26, longitude: 77.41 },
    durationDays: 2,
    outstationTripType: 'ROUND_TRIP',
  }),
  EVENT: await quote({ serviceType: 'EVENT', scheduledAt: later.toISOString(), eventPackageCode: 'FULL_DAY' }),
};
for (const [type, result] of Object.entries(results)) {
  check(`${type} quotes`, result.status === 201 && result.body.data.fare.total > 0, `${result.status} ${JSON.stringify(result.body).slice(0, 200)}`);
}
// 2 days: base 1199 + 1 extra day 1199 + allowance 2 x 300 + 1 night 400 + booking fee 29, then 5% tax.
const outstationTotal = results.OUTSTATION.body?.data?.fare?.total;
check('outstation is priced per day', outstationTotal === Math.round((1199 * 2 + 600 + 400 + 29) * 1.05 * 100) / 100, String(outstationTotal));

server.close();
await db.dropDatabase();
await mongoose.disconnect();
console.log(failures === 0 ? '\nall driver hire seed checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
