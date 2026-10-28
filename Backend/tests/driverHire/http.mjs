/**
 * Search a Driver — the HTTP contract.
 *
 *   node tests/driverHire/http.mjs
 *
 * Drives the real Express app over HTTP: routing, role checks, controllers,
 * status codes and the { success, data } / { success, code } envelopes. The
 * service suites cover the rules; this covers the wiring they cannot see — a
 * handler on the wrong path, or `/quote` swallowed by `/:bookingId`.
 */
import http from 'node:http';
import mongoose from 'mongoose';

const DB_NAME = `driver_hire_api_${Date.now()}`;
process.env.MONGODB_URI = process.env.DRIVER_HIRE_TEST_URI
  ? process.env.DRIVER_HIRE_TEST_URI.replace(/\/(\?|$)/, `/${DB_NAME}$1`)
  : `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'api-test-secret';
process.env.NODE_ENV = 'test';
process.env.DRIVER_HIRE_SWEEP_ENABLED = 'false';

const { createApp } = await import('../../src/app.js');
const { signAccessToken } = await import('../../src/modules/taxi/services/tokenService.js');
const { DRIVER_HIRE_AGREEMENT_VERSION } = await import('../../src/modules/taxi/driverHire/constants/index.js');
const { DriverHireProfile } = await import('../../src/modules/taxi/driverHire/models/DriverHireProfile.js');

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
for (const name of [
  'TaxiDriverHireProfile', 'TaxiDriverHireVehicle', 'TaxiDriverHirePricing', 'TaxiDriverHireQuote',
  'TaxiDriverHireBooking', 'TaxiDriverHirePayment', 'TaxiDriverHireReview', 'TaxiDriverHireSupportCase',
  'TaxiDriverHireAuditLog',
]) {
  await mongoose.model(name).createCollection();
  await mongoose.model(name).syncIndexes();
}

const customerId = new mongoose.Types.ObjectId();
const driverId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
await mongoose.connection.collection('taxiusers').insertOne({ _id: customerId, name: 'Riya', phone: '9000000001', active: true });
await mongoose.connection.collection('taxidrivers').insertOne({ _id: driverId, name: 'Anil Kumar', phone: '9800000001', approve: true, status: 'approved', deletedAt: null });
await mongoose.connection.collection('taxiadmins').insertOne({
  _id: adminId, name: 'Ops', email: 'ops@test.local', role: 'superadmin', admin_type: 'superadmin', permissions: ['*'], active: true,
});
await DriverHireProfile.create({
  driverId,
  verificationStatus: 'APPROVED',
  licenceNumberEncrypted: 'v1:a:b:c',
  licenceNumberLast4: '4321',
  licenceExpiry: new Date(Date.now() + 2 * 365 * 86400000),
  licenceDocumentUrl: 'https://example.test/l.png',
  transmissions: ['MANUAL', 'AUTOMATIC'],
  serviceTypes: ['SCHEDULED', 'NOW'],
  isOnline: true,
  agreementVersion: DRIVER_HIRE_AGREEMENT_VERSION,
});

const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;

const customer = signAccessToken({ sub: String(customerId), role: 'user' });
const driver = signAccessToken({ sub: String(driverId), role: 'driver' });
const admin = signAccessToken({ sub: String(adminId), role: 'admin' });

const call = async (method, path, { token, body } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
    if (status !== expected) throw new Error(`expected ${expected}, got ${status} (${body?.message || 'no message'})`);
    if (options.code && body?.code !== options.code) throw new Error(`expected code ${options.code}, got ${body?.code}`);
  });
};

const must = (condition, message) => {
  if (!condition) throw new Error(message);
};

console.log('\nAUTH AND ROLES');
await expectStatus('quote needs a token', 401, 'POST', '/driver-bookings/quote', { body: {} });
await expectStatus('a driver cannot quote', 403, 'POST', '/driver-bookings/quote', { token: driver, body: {} });
await expectStatus('a customer cannot accept', 403, 'POST', `/driver-bookings/${new mongoose.Types.ObjectId()}/accept`, { token: customer });
await expectStatus('a customer cannot open admin routes', 403, 'GET', '/admin/driver-hire/bookings', { token: customer });

console.log('\nADMIN SETUP');
await expectStatus('admin publishes pricing', 201, 'POST', '/admin/driver-hire/pricing', {
  token: admin,
  body: { serviceType: 'SCHEDULED', baseFare: 300, includedMinutes: 60, minimumMinutes: 120, extraBlockMinutes: 60, extraBlockFare: 100, bookingFee: 20, taxPercent: 5 },
});
await expectStatus('invalid pricing is a 422 with a code', 422, 'POST', '/admin/driver-hire/pricing', {
  token: admin, body: { serviceType: 'SCHEDULED', taxPercent: 90 }, code: 'INVALID_PRICING',
});

console.log('\nCUSTOMER FLOW');
let vehicleId;
let quoteId;
let bookingId;
await check('save a car', async () => {
  const { status, body } = await call('POST', '/driver-hire/vehicles', { token: customer, body: { make: 'Hyundai', model: 'Creta', transmission: 'MANUAL' } });
  must(status === 201 && body.success && body.data.vehicle.id, `status ${status}`);
  vehicleId = body.data.vehicle.id;
});
await check('availability is a count only', async () => {
  const { status, body } = await call('GET', `/drivers/availability?serviceType=SCHEDULED&transmission=MANUAL&scheduledAt=${encodeURIComponent(new Date(Date.now() + 3 * 3600000).toISOString())}`, { token: customer });
  must(status === 200 && body.data.count === 1 && !JSON.stringify(body).includes('Anil'), JSON.stringify(body));
});
await check('quote is not swallowed by /:bookingId', async () => {
  const { status, body } = await call('POST', '/driver-bookings/quote', {
    token: customer,
    body: { serviceType: 'SCHEDULED', pickup: { address: 'Vijay Nagar', latitude: 22.75, longitude: 75.89 }, scheduledAt: new Date(Date.now() + 3 * 3600000).toISOString(), durationMinutes: 180, vehicleId },
  });
  must(status === 201 && body.data.quoteId && body.data.fare.total === 546, `${status} ${JSON.stringify(body)}`);
  quoteId = body.data.quoteId;
});
await check('book', async () => {
  const { status, body } = await call('POST', '/driver-bookings', { token: customer, body: { quoteId, vehicleId, acceptTerms: true, paymentMethod: 'CASH' } });
  must(status === 201 && body.data.status === 'REQUESTED' && body.data.bookingCode.startsWith('DH'), `${status} ${body?.message}`);
  bookingId = body.data.id;
});
await expectStatus('a bad id is a 404 with a code', 404, 'GET', '/driver-bookings/not-an-id', { token: customer, code: 'BOOKING_NOT_FOUND' });

console.log('\nDRIVER FLOW');
await check('driver sees the request', async () => {
  const { status, body } = await call('GET', '/driver-hire/requests', { token: driver });
  must(status === 200 && body.data.requests.some((entry) => entry.id === bookingId), JSON.stringify(body));
});
await expectStatus('driver accepts', 200, 'POST', `/driver-bookings/${bookingId}/accept`, { token: driver });
await expectStatus('accepting twice is a 409', 409, 'POST', `/driver-bookings/${bookingId}/accept`, { token: driver, code: 'BOOKING_TAKEN' });
await check('GET returns the role-specific view', async () => {
  const asCustomer = await call('GET', `/driver-bookings/${bookingId}`, { token: customer });
  const asDriver = await call('GET', `/driver-bookings/${bookingId}`, { token: driver });
  must(asCustomer.body.data.startCode && asCustomer.body.data.driver.name === 'Anil K.', JSON.stringify(asCustomer.body.data.driver));
  must(asDriver.body.data.customer.firstName === 'Riya' && asDriver.body.data.startCode === undefined, 'driver view');
});
await expectStatus('en route', 200, 'POST', `/driver-bookings/${bookingId}/en-route`, { token: driver });
await expectStatus('arrived', 200, 'POST', `/driver-bookings/${bookingId}/arrived`, { token: driver, body: { latitude: 22.75, longitude: 75.89 } });
await expectStatus('customer confirms arrival', 200, 'POST', `/driver-bookings/${bookingId}/confirm-arrival`, { token: customer });
await expectStatus('start on the customer confirmation', 200, 'POST', `/driver-bookings/${bookingId}/start`, { token: driver, body: {} });
await expectStatus('complete', 200, 'POST', `/driver-bookings/${bookingId}/complete`, { token: driver, body: { cashCollected: true } });
await expectStatus('customer rates', 201, 'POST', `/driver-bookings/${bookingId}/rate`, { token: customer, body: { rating: 5 } });
await expectStatus('driver rates the customer', 201, 'POST', `/driver-bookings/${bookingId}/rate`, { token: driver, body: { rating: 5 } });
await expectStatus('driver earnings', 200, 'GET', '/driver-hire/earnings', { token: driver });
await expectStatus('report a problem', 201, 'POST', '/support-cases', { token: customer, body: { bookingId, category: 'LOST_PROPERTY', description: 'Left an umbrella in the car' } });

console.log('\nADMIN VIEWS');
await check('booking detail with payments and audit', async () => {
  const { status, body } = await call('GET', `/admin/driver-hire/bookings/${bookingId}`, { token: admin });
  must(status === 200 && body.data.payments.length === 1 && body.data.audit.length >= 6, `${status} ${body?.data?.audit?.length}`);
});
for (const path of ['/admin/driver-hire/bookings', '/admin/driver-hire/drivers', '/admin/driver-hire/pricing', '/admin/driver-hire/payments', '/admin/driver-hire/support-cases', '/admin/driver-hire/reviews', '/admin/driver-hire/reports', '/admin/driver-hire/audit']) {
  await expectStatus(`GET ${path}`, 200, 'GET', path, { token: admin });
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
