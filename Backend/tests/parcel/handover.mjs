/**
 * Parcel — booking validation, vehicle fit, and the handover:
 * parcel verified → pickup OTP → drop OTP → delivered.
 *
 *   node tests/parcel/handover.mjs
 *
 * Runs with PARCEL_OTP_ENFORCED both off (today's apps keep working) and on
 * (the new contract), and checks that an ordinary ride is untouched either way.
 */
import mongoose from 'mongoose';

const DB_NAME = `parcel_test_${Date.now()}`;
process.env.MONGODB_URI = process.env.PARCEL_TEST_URI
  || `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
delete process.env.PARCEL_OTP_ENFORCED;

const policy = await import('../../src/modules/taxi/user/services/parcelPolicy.js');
const handover = await import('../../src/modules/taxi/user/services/parcelHandoverService.js');
const deliveryService = await import('../../src/modules/taxi/user/services/deliveryService.js');
const rideService = await import('../../src/modules/taxi/services/rideService.js');
const dispatchService = await import('../../src/modules/taxi/services/dispatchService.js');
const { migrateParcelWeights } = await import('../../scripts/migrateParcelWeights.js');
const { Ride } = await import('../../src/modules/taxi/user/models/Ride.js');
const { Delivery } = await import('../../src/modules/taxi/user/models/Delivery.js');
const { Vehicle } = await import('../../src/modules/taxi/admin/models/Vehicle.js');
await import('../../src/modules/taxi/user/models/User.js');
await import('../../src/modules/taxi/driver/models/Driver.js');

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

for (const name of ['TaxiRide', 'Delivery', 'TaxiUser', 'TaxiDriver', 'TaxiVehicle']) {
  await mongoose.model(name).createCollection().catch(() => null);
}

const emitted = [];
dispatchService.setSocketServer({
  to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
  in: () => ({ socketsLeave: () => {} }),
});

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

const enforce = (on) => {
  process.env.PARCEL_OTP_ENFORCED = on ? 'true' : 'false';
};

const sender = new mongoose.Types.ObjectId();
const driverId = new mongoose.Types.ObjectId();
const otherDriver = new mongoose.Types.ObjectId();

await mongoose.connection.collection('taxiusers').insertOne({ _id: sender, name: 'Varun', phone: '9876543210' });
await mongoose.connection.collection('taxidrivers').insertMany([
  { _id: driverId, name: 'Rakesh', phone: '9998887777', isOnRide: true },
  { _id: otherDriver, name: 'Other', phone: '9998887766' },
]);

const point = (lng, lat) => ({ type: 'Point', coordinates: [lng, lat] });

/** A parcel ride with a Delivery companion, assigned to the driver. */
const parcelRide = async ({ liveStatus = 'accepted', serviceType = 'parcel' } = {}) => {
  const ride = await Ride.create({
    userId: sender,
    driverId,
    serviceType,
    status: liveStatus === 'accepted' || liveStatus === 'arriving' ? 'accepted' : 'ongoing',
    liveStatus,
    fare: 120,
    otp: '4321',
    pickupLocation: point(77.51, 28.46),
    dropLocation: point(77.52, 28.47),
    pickupAddress: 'Sector 36',
    dropAddress: 'Sector 50',
    parcel: { category: 'Documents', weight: '2 kg', size: 'small', photoUrl: 'https://cdn/x.jpg' },
  });

  if (serviceType !== 'parcel') {
    return { ride, delivery: null };
  }

  const delivery = await Delivery.create({
    rideId: ride._id,
    userId: sender,
    driverId,
    status: ride.status,
    liveStatus: ride.liveStatus,
    pickupLocation: ride.pickupLocation,
    dropLocation: ride.dropLocation,
    fare: 120,
    parcel: ride.parcel,
  });

  ride.deliveryId = delivery._id;
  await ride.save();
  return { ride, delivery };
};

const senderCodes = async (deliveryId) =>
  handover.serializeHandover(await handover.loadDeliveryHandover(deliveryId), { viewerRole: 'user' }).codes;

console.log('\nPOLICY — ORDINARY RIDES UNTOUCHED');

await check('a normal ride keeps its otp with enforcement on or off', async () => {
  const { ride } = await parcelRide({ serviceType: 'ride' });
  for (const on of [false, true]) {
    enforce(on);
    if (policy.visibleRideOtp(ride) !== '4321') throw new Error(`hidden with enforced=${on}`);
    if (rideService.serializeRideRealtime(ride).otp !== '4321') throw new Error('realtime payload changed');
  }
  enforce(false);
});

await check('a normal ride is never blocked by the parcel step guard', async () => {
  enforce(true);
  const { ride } = await parcelRide({ serviceType: 'ride' });
  if (policy.parcelStepBlocker(ride, 'started') || policy.parcelStepBlocker(ride, 'completed')) throw new Error('blocked');
  enforce(false);
});

await check('a parcel keeps its otp while enforcement is off (current driver app checks it)', async () => {
  const { ride } = await parcelRide();
  if (rideService.serializeRideRealtime(ride).otp !== '4321') throw new Error('otp hidden too early');
});

await check('weights parse from labels and numbers', () => {
  const cases = [['5', 5], ['5 kg', 5], ['2.5kg', 2.5], ['2,5', 2.5], [3, 3], ['', null], ['heavy', null], [null, null]];
  for (const [input, want] of cases) {
    if (policy.parseWeightKg(input) !== want) throw new Error(`${input} -> ${policy.parseWeightKg(input)}`);
  }
});

console.log('\nBOOKING VALIDATION');

await check('the current app (no new fields) still validates with enforcement off', () => {
  deliveryService.normalizeParcelInput({ category: 'Documents', weight: '', senderName: 'A' }, { forBooking: true });
});

await expectReject('weight over the limit is refused', 'INVALID_PARCEL', async () =>
  deliveryService.normalizeParcelInput({ weight: 9999 }));

await expectReject('an unknown size is refused', 'INVALID_PARCEL', async () =>
  deliveryService.normalizeParcelInput({ size: 'huge' }));

await expectReject('a custom size needs all three dimensions', 'INVALID_PARCEL', async () =>
  deliveryService.normalizeParcelInput({ size: 'custom', customSize: { length: 10, width: 10 } }));

await check('enforced booking requires photo, size, weight and valid mobiles', async () => {
  enforce(true);
  const full = {
    weight: '3', size: 'medium', photoUrl: 'https://cdn/p.jpg',
    senderName: 'Varun', senderMobile: '+91 98765 43210', receiverName: 'Asha', receiverMobile: '09876501234',
  };
  const ok = deliveryService.normalizeParcelInput(full, { forBooking: true });
  if (ok.senderMobile !== '9876543210' || ok.receiverMobile !== '9876501234') throw new Error('mobiles not normalized');

  for (const missing of ['photoUrl', 'size', 'weight', 'receiverName']) {
    let code = null;
    try {
      deliveryService.normalizeParcelInput({ ...full, [missing]: '' }, { forBooking: true });
    } catch (error) {
      code = error.code;
    }
    if (code !== 'INVALID_PARCEL') throw new Error(`${missing} missing was accepted`);
  }

  let badMobile = null;
  try {
    deliveryService.normalizeParcelInput({ ...full, receiverMobile: '12345' }, { forBooking: true });
  } catch (error) {
    badMobile = error.code;
  }
  if (badMobile !== 'INVALID_PARCEL') throw new Error('bad mobile accepted');

  // A quote is never strict: the user is still filling the form in.
  deliveryService.normalizeParcelInput({}, { forBooking: false });
  enforce(false);
});

console.log('\nVEHICLE FIT');

await check('limits: weight and size, with no limits meaning anything goes', () => {
  const bike = { parcel_limits: { max_weight_kg: 10, max_size: 'small' } };
  const car = { parcel_limits: { max_weight_kg: 50, max_size: 'medium' } };
  const open = { parcel_limits: {} };
  const can = deliveryService.vehicleCanCarryParcel;

  if (!can(bike, { weight: 5, size: 'small' })) throw new Error('bike refused a small parcel');
  if (can(bike, { weight: 15, size: 'small' })) throw new Error('bike took 15 kg');
  if (can(bike, { weight: 5, size: 'medium' })) throw new Error('bike took a medium parcel');
  if (!can(car, { weight: 20, size: 'medium' })) throw new Error('car refused medium');
  if (!can(open, { weight: 400, size: 'custom', customSize: { length: 200, width: 100, height: 100 } })) throw new Error('unlimited refused');
  // A custom box is classed by its longest side.
  if (!can(bike, { weight: 1, size: 'custom', customSize: { length: 30, width: 20, height: 10 } })) throw new Error('small custom box refused');
});

await check('the quote lists only the vehicle types that fit', async () => {
  const bike = await Vehicle.create({ name: 'Bike Parcel', transport_type: 'delivery', status: 1, parcel_limits: { max_weight_kg: 10, max_size: 'small' } });
  const truck = await Vehicle.create({ name: 'Pickup Truck', transport_type: 'delivery', status: 1, parcel_limits: { max_weight_kg: 500, max_size: 'custom' } });

  const quote = await deliveryService.quoteDelivery({
    pickup: [77.51, 28.46], drop: [77.52, 28.47], vehicleTypeId: bike._id, parcel: { weight: 40, size: 'large' },
  });

  const ids = quote.suitableVehicleTypes.map((v) => v.vehicleTypeId);
  if (ids.includes(String(bike._id)) || !ids.includes(String(truck._id))) throw new Error(JSON.stringify(ids));
  if (quote.vehicleFits !== false) throw new Error('chosen bike reported as fitting');

  const plain = await deliveryService.quoteDelivery({ pickup: [77.51, 28.46], drop: [77.52, 28.47], parcel: {} });
  if ('suitableVehicleTypes' in plain) throw new Error('undescribed parcel got a vehicle list');
});

console.log('\nHANDOVER — ENFORCEMENT OFF (today)');

const flow = await parcelRide({ liveStatus: 'accepted' });

await expectReject('pickup OTP before the parcel is verified', 'PARCEL_NOT_VERIFIED', () =>
  handover.verifyPickupOtp({ deliveryId: flow.delivery._id, driverId, otp: '0000' }));

await expectReject('another driver cannot touch the delivery', 'DELIVERY_NOT_FOUND', () =>
  handover.markParcelVerified({ deliveryId: flow.delivery._id, driverId: otherDriver }));

await check('parcel verified issues a pickup code to the sender only', async () => {
  emitted.length = 0;
  const state = await handover.markParcelVerified({ deliveryId: flow.delivery._id, driverId });
  if (!state.parcelVerified || !state.pickupOtp.issued) throw new Error(JSON.stringify(state));
  if ('codes' in state) throw new Error('driver response carried codes');

  const otpEvents = emitted.filter((e) => e.event === 'delivery:otp');
  if (otpEvents.length !== 1 || otpEvents[0].room !== `user:${sender}`) throw new Error(JSON.stringify(otpEvents.map((e) => e.room)));
  if (emitted.some((e) => e.room.startsWith('ride_') && JSON.stringify(e.payload).includes(otpEvents[0].payload.otp))) {
    throw new Error('code broadcast to the ride room');
  }

  const codes = await senderCodes(flow.delivery._id);
  if (!/^\d{4}$/.test(codes.pickup || '') || codes.drop) throw new Error(JSON.stringify(codes));

  const mirrored = await Ride.findById(flow.ride._id);
  if (!mirrored.parcelHandover.parcelVerified) throw new Error('not mirrored onto the ride');
});

await check('tapping parcel verified twice does not mint a second code', async () => {
  const before = (await senderCodes(flow.delivery._id)).pickup;
  await handover.markParcelVerified({ deliveryId: flow.delivery._id, driverId });
  if ((await senderCodes(flow.delivery._id)).pickup !== before) throw new Error('code changed');
});

await check('a wrong code counts down attempts', async () => {
  const code = (await senderCodes(flow.delivery._id)).pickup;
  const wrong = code === '0000' ? '1111' : '0000';
  try {
    await handover.verifyPickupOtp({ deliveryId: flow.delivery._id, driverId, otp: wrong });
    throw new Error('wrong code accepted');
  } catch (error) {
    if (error.code !== 'INVALID_OTP' || error.details?.attemptsRemaining !== 4) throw new Error(`${error.code} ${JSON.stringify(error.details)}`);
  }
});

await check('the right code starts the trip and issues the drop code', async () => {
  const code = (await senderCodes(flow.delivery._id)).pickup;
  const state = await handover.verifyPickupOtp({ deliveryId: flow.delivery._id, driverId, otp: code });
  if (!state.pickupOtp.verified || !state.dropOtp.issued) throw new Error(JSON.stringify(state));

  const ride = await Ride.findById(flow.ride._id);
  if (ride.liveStatus !== 'started') throw new Error(`ride is ${ride.liveStatus}`);
  if (!ride.parcelHandover.pickupOtpVerified) throw new Error('not mirrored');

  const codes = await senderCodes(flow.delivery._id);
  if (codes.pickup || !/^\d{4}$/.test(codes.drop || '')) throw new Error(JSON.stringify(codes));
});

await expectReject('a spent pickup code cannot be replayed', 'OTP_ALREADY_VERIFIED', async () =>
  handover.verifyPickupOtp({ deliveryId: flow.delivery._id, driverId, otp: '1234' }));

await check('the drop code completes the delivery', async () => {
  const code = (await senderCodes(flow.delivery._id)).drop;
  const state = await handover.verifyDropOtp({ deliveryId: flow.delivery._id, driverId, otp: code });
  if (!state.dropOtp.verified || !state.deliveredAt) throw new Error(JSON.stringify(state));
  const ride = await Ride.findById(flow.ride._id);
  if (ride.status !== 'completed') throw new Error(`ride is ${ride.status}`);
});

await expectReject('a completed delivery is closed', 'DELIVERY_CLOSED', () =>
  handover.markParcelVerified({ deliveryId: flow.delivery._id, driverId }));

await check('five wrong codes lock it; the sender reissues a fresh one', async () => {
  const { delivery } = await parcelRide({ liveStatus: 'arriving' });
  await handover.markParcelVerified({ deliveryId: delivery._id, driverId });
  const code = (await senderCodes(delivery._id)).pickup;
  const wrong = code === '0000' ? '1111' : '0000';

  for (let i = 0; i < 5; i += 1) {
    await handover.verifyPickupOtp({ deliveryId: delivery._id, driverId, otp: wrong }).catch(() => null);
  }

  let locked = null;
  await handover.verifyPickupOtp({ deliveryId: delivery._id, driverId, otp: code }).catch((error) => { locked = error.code; });
  if (locked !== 'OTP_ATTEMPTS_EXCEEDED') throw new Error(`got ${locked} — even the right code must be refused once locked`);

  const reissued = await handover.reissueParcelOtp({ deliveryId: delivery._id, userId: sender, kind: 'pickup' });
  const state = await handover.verifyPickupOtp({ deliveryId: delivery._id, driverId, otp: reissued.otp });
  if (!state.pickupOtp.verified) throw new Error('reissued code refused');
});

await expectReject('someone else cannot reissue the sender\'s code', 'DELIVERY_NOT_FOUND', async () => {
  const { delivery } = await parcelRide({ liveStatus: 'arriving' });
  await handover.markParcelVerified({ deliveryId: delivery._id, driverId });
  return handover.reissueParcelOtp({ deliveryId: delivery._id, userId: new mongoose.Types.ObjectId(), kind: 'pickup' });
});

console.log('\nSECRETS NEVER LEAK INTO RIDE PAYLOADS');

await check('populated ride detail and realtime payload carry no hash or ciphertext', async () => {
  const { ride, delivery } = await parcelRide({ liveStatus: 'arriving' });
  await handover.markParcelVerified({ deliveryId: delivery._id, driverId });

  const detailed = await rideService.getRideDetails(ride._id);
  const text = JSON.stringify([await rideService.serializeRideDetail(detailed), rideService.serializeRideRealtime(detailed)]);
  const stored = await Delivery.findById(delivery._id).select('+handover.pickupOtp.hash +handover.pickupOtp.encrypted');

  if (text.includes(stored.handover.pickupOtp.hash)) throw new Error('hash leaked');
  if (text.includes(stored.handover.pickupOtp.encrypted)) throw new Error('ciphertext leaked');
});

await check('the driver view of a delivery never includes codes; the sender view does', async () => {
  const { ride, delivery } = await parcelRide({ liveStatus: 'arriving' });
  await handover.markParcelVerified({ deliveryId: delivery._id, driverId });
  const detailed = await rideService.getRideDetails(ride._id);

  const asDriver = await deliveryService.serializeDeliveryForViewer(detailed, { role: 'driver' });
  const asSender = await deliveryService.serializeDeliveryForViewer(detailed, { role: 'user' });
  const code = (await senderCodes(delivery._id)).pickup;

  if (JSON.stringify(asDriver).includes(`"${code}"`) || asDriver.handover.codes) throw new Error('driver saw the code');
  if (asSender.handover.codes?.pickup !== code) throw new Error('sender cannot see the code');
});

console.log('\nHANDOVER — ENFORCEMENT ON (new apps)');

await check('the ride otp is hidden for a parcel, and the sender view shows the live code instead', async () => {
  enforce(true);
  const { ride, delivery } = await parcelRide({ liveStatus: 'arriving' });

  let detailed = await rideService.getRideDetails(ride._id);
  if (rideService.serializeRideRealtime(detailed).otp !== '') throw new Error('realtime otp visible');
  if ((await rideService.serializeRideDetail(detailed)).otp !== '') throw new Error('detail otp visible');
  if ((await deliveryService.serializeDeliveryForViewer(detailed, { role: 'user' })).otp !== '') {
    throw new Error('sender saw a code before the parcel was verified');
  }

  await handover.markParcelVerified({ deliveryId: delivery._id, driverId });
  detailed = await rideService.getRideDetails(ride._id);
  const asSender = await deliveryService.serializeDeliveryForViewer(detailed, { role: 'user' });
  if (asSender.otp !== asSender.handover.codes.pickup || !asSender.otp) throw new Error('otp is not the pickup code');
  enforce(false);
});

await expectReject('the driver cannot start the trip without the pickup code', 'PARCEL_STEP_REQUIRED', async () => {
  enforce(true);
  const { ride } = await parcelRide({ liveStatus: 'arriving' });
  try {
    return await rideService.updateRideLifecycle({ rideId: ride._id, driverId, nextStatus: 'started' });
  } finally {
    enforce(false);
  }
});

await expectReject('the driver cannot complete without the drop code', 'PARCEL_STEP_REQUIRED', async () => {
  enforce(true);
  const { ride } = await parcelRide({ liveStatus: 'arrived' });
  await Ride.updateOne({ _id: ride._id }, { $set: { 'parcelHandover.pickupOtpVerified': true } });
  try {
    return await rideService.updateRideLifecycle({ rideId: ride._id, driverId, nextStatus: 'completed' });
  } finally {
    enforce(false);
  }
});

await expectReject('parcel verified requires arriving at the pickup first', 'PARCEL_INVALID_STEP', async () => {
  enforce(true);
  const { delivery } = await parcelRide({ liveStatus: 'accepted' });
  try {
    return await handover.markParcelVerified({ deliveryId: delivery._id, driverId });
  } finally {
    enforce(false);
  }
});

await check('an ordinary ride still starts and completes with enforcement on', async () => {
  enforce(true);
  const { ride } = await parcelRide({ serviceType: 'ride', liveStatus: 'arriving' });
  await rideService.updateRideLifecycle({ rideId: ride._id, driverId, nextStatus: 'started' });
  const started = await Ride.findById(ride._id);
  if (started.liveStatus !== 'started') throw new Error(`ride is ${started.liveStatus}`);
  enforce(false);
});

console.log('\nMIGRATION');

await check('string weights become numbers, idempotently', async () => {
  const rides = mongoose.connection.collection('taxirides');
  const ids = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  await rides.insertMany([
    { _id: ids[0], serviceType: 'parcel', parcel: { weight: '' } },
    { _id: ids[1], serviceType: 'parcel', parcel: { weight: '7 kg' } },
  ]);

  const first = await migrateParcelWeights({ apply: true, log: () => {} });
  const [a, b] = await Promise.all(ids.map((_id) => rides.findOne({ _id })));
  if (a.parcel.weight !== null || b.parcel.weight !== 7) throw new Error(`${a.parcel.weight} / ${b.parcel.weight}`);
  if (first.taxirides.scanned < 2) throw new Error('did not scan');

  const second = await migrateParcelWeights({ apply: true, log: () => {} });
  if (second.taxirides.scanned !== 0) throw new Error('second run found strings');
});

console.log(`\n${pass} passed, ${fail} failed`);

await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
