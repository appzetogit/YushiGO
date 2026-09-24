/**
 * Carpool — host documents and the publish gate, the per-km price cap, and the
 * booking additions: route validation, extra stop, price offers, door-to-door.
 *
 *   node tests/carpool/documents.mjs
 */
import mongoose from 'mongoose';

const DB_NAME = `carpool_documents_${Date.now()}`;
process.env.MONGODB_URI = process.env.CARPOOL_TEST_URI
  || `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
process.env.CARPOOL_INSTANT_BOOKING = 'false';
delete process.env.CARPOOL_REQUIRE_VERIFIED_VEHICLE;

const vehicleService = await import('../../src/modules/taxi/carpool/services/carpoolVehicleService.js');
const documentService = await import('../../src/modules/taxi/carpool/services/carpoolDocumentService.js');
const pricing = await import('../../src/modules/taxi/carpool/services/carpoolPricingService.js');
const rideService = await import('../../src/modules/taxi/carpool/services/carpoolRideService.js');
const bookingService = await import('../../src/modules/taxi/carpool/services/carpoolBookingService.js');
const { CarpoolVehicle } = await import('../../src/modules/taxi/carpool/models/CarpoolVehicle.js');
const { CarpoolDocument } = await import('../../src/modules/taxi/carpool/models/CarpoolDocument.js');
await import('../../src/modules/taxi/admin/models/AdminBusinessSetting.js');
await import('../../src/modules/taxi/admin/models/AdminThirdPartySetting.js');

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

for (const name of ['TaxiCarpoolVehicle', 'TaxiCarpoolRide', 'TaxiCarpoolBooking', 'TaxiCarpoolDocument', 'TaxiAdminBusinessSetting', 'TaxiAdminThirdPartySetting']) {
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
const adminId = new mongoose.Types.ObjectId();
await mongoose.connection.collection('taxiusers').insertMany([
  { _id: host, name: 'Varun', gender: 'male' },
  { _id: alice, name: 'Alice', gender: 'female' },
  { _id: bob, name: 'Bob', gender: 'male' },
]);

// 1x1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const inYears = (years) => new Date(Date.now() + years * 365 * 86400000).toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

const INDORE = { name: 'Indore', lat: 22.7196, lng: 75.8577 };
const DEWAS = { name: 'Dewas', lat: 22.9676, lng: 76.0534 };
const UJJAIN = { name: 'Ujjain', lat: 23.1765, lng: 75.7885 };
const BHOPAL = { name: 'Bhopal', lat: 23.2599, lng: 77.4126 };

const vehicle = await vehicleService.createVehicle({
  userId: host,
  payload: { model: 'Hyundai i20', registrationNumber: 'MP09AB1234', seatCapacity: 4 },
});

const ridePayload = (extra = {}) => ({
  vehicle_id: vehicle.id, origin: INDORE, destination: UJJAIN, pickup: INDORE, drop: UJJAIN,
  stops: [{ ...DEWAS, order: 1 }], date: tomorrow, departure_time: '10:30',
  available_seats: 3, price_per_seat: 150, ...extra,
});
const publish = (extra) => rideService.createRide({ userId: host, payload: ridePayload(extra) });
const upload = (kind, extra = {}) => documentService.uploadDocument({ userId: host, payload: { kind, file: PNG, ...extra } });

console.log('\nDOCUMENTS AND THE PUBLISH GATE (on by default)');

await expectReject('an unverified host cannot publish', 'VEHICLE_NOT_VERIFIED', () => publish());

await expectReject('a licence needs an expiry date', 'INVALID_DOCUMENT', () => upload('drivingLicense'));
await expectReject('an already-expired insurance is refused', 'DOCUMENT_EXPIRED', () =>
  upload('insurance', { vehicle_id: vehicle.id, expiry_date: '2020-01-01' }));
await expectReject('RC for a vehicle the host does not own is refused', 'INVALID_VEHICLE', () =>
  documentService.uploadDocument({ userId: bob, payload: { kind: 'rc', file: PNG, vehicle_id: vehicle.id } }));
await expectReject('a non-image, non-PDF file is refused', 'INVALID_DOCUMENT', () =>
  upload('driverPhoto', { file: 'data:text/plain;base64,aGVsbG8=' }));

const docs = {};

await check('uploading all four puts the vehicle in PENDING and status lists them', async () => {
  docs.photo = await upload('driverPhoto');
  docs.licence = await upload('drivingLicense', { expiry_date: inYears(5) });
  docs.rc = await upload('rc', { vehicle_id: vehicle.id });
  docs.insurance = await upload('insurance', { vehicle_id: vehicle.id, expiry_date: inYears(1) });

  const status = await documentService.getDocumentStatus({ userId: host });
  if (status.canPublish) throw new Error('publishable before review');
  if (status.vehicles[0].verificationStatus !== 'PENDING') throw new Error(status.vehicles[0].verificationStatus);
  if (!status.host.drivingLicense || !status.vehicles[0].documents.insurance) throw new Error('documents missing from status');
});

await check('the admin sees the pending documents with host and vehicle', async () => {
  const list = await documentService.listDocumentsForAdmin({ status: 'PENDING' });
  if (list.results.length !== 4 || list.counts.PENDING !== 4) throw new Error(`${list.results.length} / ${JSON.stringify(list.counts)}`);
  const rc = list.results.find((d) => d.kind === 'rc');
  if (rc.vehicle?.registrationNumber !== 'MP09AB1234' || rc.host?.name !== 'Varun') throw new Error('context missing');
});

await expectReject('rejecting needs a reason', 'INVALID_DOCUMENT', () =>
  documentService.rejectDocument({ documentId: docs.rc.id, adminId, reason: ' ' }));

await check('a rejected document marks the vehicle REJECTED', async () => {
  await documentService.rejectDocument({ documentId: docs.rc.id, adminId, reason: 'RC photo is blurry' });
  const v = await CarpoolVehicle.findById(vehicle.id);
  if (v.verificationStatus !== 'REJECTED') throw new Error(v.verificationStatus);
});

await check('re-uploading supersedes the rejected copy; approving all four verifies the vehicle', async () => {
  docs.rc = await upload('rc', { vehicle_id: vehicle.id });
  const old = await CarpoolDocument.countDocuments({ kind: 'rc', isCurrent: false });
  if (old !== 1) throw new Error('old copy not kept as history');

  for (const doc of [docs.photo, docs.licence, docs.rc, docs.insurance]) {
    await documentService.approveDocument({ documentId: doc.id, adminId });
  }

  const v = await CarpoolVehicle.findById(vehicle.id);
  if (v.verificationStatus !== 'VERIFIED') throw new Error(v.verificationStatus);
  const status = await documentService.getDocumentStatus({ userId: host });
  if (!status.canPublish) throw new Error('status says cannot publish');
});

await expectReject('an outdated document cannot be reviewed', 'INVALID_DOCUMENT', async () => {
  const stale = await CarpoolDocument.findOne({ kind: 'rc', isCurrent: false });
  return documentService.approveDocument({ documentId: stale._id, adminId });
});

await check('a verified host publishes', async () => {
  const ride = await publish();
  if (!ride.rideId) throw new Error('no ride');
});

await expectReject('insurance lapsing before the ride blocks publishing', 'DOCUMENT_EXPIRED', async () => {
  await CarpoolDocument.updateOne({ _id: docs.insurance.id }, { $set: { expiryDate: new Date(Date.now() + 3600000) } });
  try {
    return await publish({ date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) });
  } finally {
    await CarpoolDocument.updateOne({ _id: docs.insurance.id }, { $set: { expiryDate: new Date(inYears(1)) } });
  }
});

await check('documents are never exposed on the public ride view', async () => {
  const ride = await publish();
  const view = await rideService.getRideById({ rideId: ride.rideId, userId: alice });
  const text = JSON.stringify(view);
  if (text.includes('carpool-documents') || text.includes('drivingLicense')) throw new Error('document leaked');
  if (view.vehicle?.verified !== true) throw new Error('verified badge missing');
});

console.log('\nPRICE CAP');

await check('without an admin rate the old flat limit still applies', async () => {
  const limit = await pricing.priceLimitFor([[INDORE.lng, INDORE.lat], [UJJAIN.lng, UJJAIN.lat]]);
  if (limit.basis !== 'flat_limit' || limit.maxPrice !== 10000) throw new Error(JSON.stringify(limit));
  if (limit.source !== 'straight_line' || !(limit.distanceKm > 40)) throw new Error(`distance ${limit.distanceKm}`);
});

await check('with a rate, the cap is rate × route distance and is enforced', async () => {
  await mongoose.connection.collection('taxiadminbusinesssettings').updateOne(
    { scope: 'default' }, { $set: { carpool: { rate_per_km: 2 } } }, { upsert: true },
  );
  const limit = await pricing.priceLimitFor([[INDORE.lng, INDORE.lat], [DEWAS.lng, DEWAS.lat], [UJJAIN.lng, UJJAIN.lat]]);
  if (limit.basis !== 'rate_per_km' || limit.maxPrice !== Math.round(2 * limit.distanceKm)) throw new Error(JSON.stringify(limit));

  let code = null;
  await publish({ price_per_seat: limit.maxPrice + 1 }).catch((e) => { code = e.code; });
  if (code !== 'PRICE_ABOVE_LIMIT') throw new Error(`over the cap -> ${code}`);

  const ok = await publish({ price_per_seat: limit.maxPrice });
  const stored = await mongoose.connection.collection('taxicarpoolrides').findOne({ _id: new mongoose.Types.ObjectId(ok.rideId) });
  if (stored.maxPricePerSeat !== limit.maxPrice || !(stored.routeDistanceKm > 0)) throw new Error('cap not recorded on the ride');

  await mongoose.connection.collection('taxiadminbusinesssettings').updateOne({ scope: 'default' }, { $unset: { carpool: '' } });
});

console.log('\nBOOKING: ROUTE, STOP, OFFER');

const book = (rideId, userId, payload) => bookingService.createBooking({ rideId, userId, payload });

await expectReject('a pickup nowhere near the route is refused', 'OUTSIDE_ROUTE', async () => {
  const ride = await publish();
  return book(ride.rideId, alice, { seat_count: 1, pickup: BHOPAL, drop: UJJAIN });
});

await expectReject('travelling against the route direction is refused', 'OUTSIDE_ROUTE', async () => {
  const ride = await publish();
  return book(ride.rideId, alice, { seat_count: 1, pickup: UJJAIN, drop: DEWAS });
});

await expectReject('an extra stop off the route is refused', 'OUTSIDE_ROUTE', async () => {
  const ride = await publish();
  return book(ride.rideId, alice, { seat_count: 1, pickup: DEWAS, drop: UJJAIN, stoppage: BHOPAL });
});

await expectReject('offering more than the host asks needs a stop or door-to-door', 'INVALID_OFFER', async () => {
  const ride = await publish();
  return book(ride.rideId, alice, { seat_count: 1, pickup: DEWAS, drop: UJJAIN, offered_price: 200 });
});

await check('a lower offer is a negotiation the host accepts at that price', async () => {
  const ride = await publish();
  const booking = await book(ride.rideId, alice, { seat_count: 2, pickup: DEWAS, drop: UJJAIN, offered_price: 120 });
  if (booking.negotiationStatus !== 'offered' || booking.pricePerSeat !== 120 || booking.driverPricePerSeat !== 150) {
    throw new Error(JSON.stringify(booking));
  }
  if (booking.totalAmount !== 240) throw new Error(`total ${booking.totalAmount}`);

  const accepted = await bookingService.acceptBooking({ bookingId: booking.bookingId, userId: host });
  if (accepted.negotiationStatus !== 'accepted' || accepted.pricePerSeat !== 120) throw new Error(JSON.stringify(accepted));
});

await check('an offer above the price is allowed with an extra stop on the route', async () => {
  const ride = await publish();
  const midway = { name: 'Midway', lat: 22.95, lng: 76.04 };
  const booking = await book(ride.rideId, bob, { seat_count: 1, pickup: DEWAS, drop: UJJAIN, stoppage: midway, offered_price: 200 });
  if (booking.offeredPrice !== 200 || !booking.stoppage) throw new Error(JSON.stringify(booking));

  const rejected = await bookingService.rejectBooking({ bookingId: booking.bookingId, userId: host });
  if (rejected.negotiationStatus !== 'rejected') throw new Error(rejected.negotiationStatus);
});

await check('an offer is never instant-booked, even with instant booking on', async () => {
  process.env.CARPOOL_INSTANT_BOOKING = 'true';
  try {
    const ride = await publish();
    const booking = await book(ride.rideId, alice, { seat_count: 1, pickup: DEWAS, drop: UJJAIN, offered_price: 100 });
    if (booking.status !== 'PENDING') throw new Error(booking.status);
  } finally {
    process.env.CARPOOL_INSTANT_BOOKING = 'false';
  }
});

console.log('\nDOOR-TO-DOOR');

await check('takes every seat at the same price per car, with the wider detour', async () => {
  await mongoose.connection.collection('taxiadminbusinesssettings').updateOne(
    { scope: 'default' }, { $set: { carpool: { door_to_door_max_detour_km: 25 } } }, { upsert: true },
  );
  const ride = await publish({ available_seats: 3 });
  // ~10 km west of the Indore–Dewas leg: outside the 3 km buffer, inside the
  // 25 km door-to-door limit.
  const home = { name: 'Home', lat: 22.80, lng: 75.80 };
  const booking = await book(ride.rideId, alice, { seat_count: 1, pickup: home, drop: UJJAIN, is_door_to_door: true });
  if (!booking.isDoorToDoor || booking.seatCount !== 3) throw new Error(JSON.stringify(booking));
  if (booking.totalAmount !== 450) throw new Error(`total ${booking.totalAmount}`);

  let normal = null;
  await book(ride.rideId, bob, { seat_count: 1, pickup: home, drop: UJJAIN }).catch((e) => { normal = e.code; });
  if (normal !== 'OUTSIDE_ROUTE') throw new Error(`same detour without door-to-door -> ${normal}`);
});

await expectReject('not available once someone else has asked for a seat', 'DOOR_TO_DOOR_UNAVAILABLE', async () => {
  const ride = await publish();
  await book(ride.rideId, bob, { seat_count: 1, pickup: DEWAS, drop: UJJAIN });
  return book(ride.rideId, alice, { seat_count: 1, pickup: DEWAS, drop: UJJAIN, is_door_to_door: true });
});

console.log(`\n${pass} passed, ${fail} failed`);

await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
