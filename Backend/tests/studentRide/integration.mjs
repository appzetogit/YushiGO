/**
 * Student Ride — integration with the shared dispatch engine.
 *
 *   node tests/studentRide/integration.mjs
 *
 * Two halves, and the second matters more. Every change here touches code that
 * normal rides, parcels and medicine also run through, so alongside "the student
 * ride now works" this asserts "nothing else noticed": no StudentRide reads for
 * a normal ride, no new count query on ride detail, no new key on a normal offer.
 */
import mongoose from 'mongoose';

const DB_NAME = `student_ride_integration_${Date.now()}`;
process.env.MONGODB_URI = process.env.STUDENT_RIDE_TEST_URI
  || `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';

const studentService = await import('../../src/modules/taxi/studentRide/services/studentService.js');
const locationService = await import('../../src/modules/taxi/studentRide/services/savedLocationService.js');
const rideService = await import('../../src/modules/taxi/studentRide/services/studentRideService.js');
const dispatch = await import('../../src/modules/taxi/studentRide/services/dispatchAdapter.js');
const adminService = await import('../../src/modules/taxi/studentRide/services/adminStudentRideService.js');
const { syncStudentRideWithDispatch } = await import('../../src/modules/taxi/studentRide/services/statusSyncService.js');
const { studentDriverBlock } = await import('../../src/modules/taxi/studentRide/services/driverPayload.js');
const coreRide = await import('../../src/modules/taxi/services/rideService.js');
const dispatchService = await import('../../src/modules/taxi/services/dispatchService.js');
const { StudentRide } = await import('../../src/modules/taxi/studentRide/models/StudentRide.js');
const { StudentRideEvent } = await import('../../src/modules/taxi/studentRide/models/StudentRideEvent.js');
const { Ride } = await import('../../src/modules/taxi/user/models/Ride.js');
await import('../../src/modules/taxi/user/models/User.js');
await import('../../src/modules/taxi/driver/models/Driver.js');

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

for (const name of [
  'TaxiStudent', 'TaxiStudentGuardian', 'TaxiStudentSavedLocation', 'TaxiStudentRide',
  'TaxiStudentRideEvent', 'TaxiStudentRideShareToken', 'TaxiStudentRideEmergency',
  'TaxiRide', 'TaxiUser', 'TaxiDriver',
]) {
  await mongoose.model(name).createCollection().catch(() => null);
}

// Every socket emission is captured, so ordering and audience can be asserted.
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

const parent = new mongoose.Types.ObjectId();
const driverId = new mongoose.Types.ObjectId();
const vehicleTypeId = new mongoose.Types.ObjectId();

await mongoose.connection.collection('taxiusers').insertOne({ _id: parent, name: 'Varun', gender: 'male' });
await mongoose.connection.collection('taxidrivers').insertOne({
  _id: driverId, name: 'Rakesh Kumar', phone: '9998887777', rating: 4.8,
  vehicleNumber: 'MP09AB1234', vehicleMake: 'Maruti', vehicleModel: 'Swift', completedRidesCount: 152,
});
await mongoose.connection.collection('taxivehicles').insertOne({
  _id: vehicleTypeId, name: 'YushiGo Fast', capacity: 5, service_tax: 0,
});
await mongoose.connection.collection('taxisetprices').insertOne({
  vehicle_type: vehicleTypeId, transport_type: 'taxi', active: 1, status: 'active',
  zone_id: null, service_location_id: null,
  base_price: 30, base_distance: 2, price_per_distance: 12, service_tax: 0,
});

const student = await studentService.createStudent({
  userId: parent,
  payload: {
    name: 'Aarohi Sharma', dateOfBirth: '2014-08-12',
    guardians: [{ name: 'Varun', mobile: '9876543210', relationship: 'FATHER' }],
  },
});
const home = await locationService.createSavedLocation({
  studentId: student.id, userId: parent,
  payload: { label: 'HOME', address: 'Sector 36', latitude: 28.46, longitude: 77.51 },
});
const school = await locationService.createSavedLocation({
  studentId: student.id, userId: parent,
  payload: { label: 'SCHOOL', address: 'School', latitude: 28.47, longitude: 77.52 },
});

const booked = async (extra = {}) => {
  const ride = await rideService.createStudentRide({
    userId: parent,
    payload: {
      student_id: student.id,
      pickup_saved_location_id: home.id,
      destination_saved_location_id: school.id,
      vehicle_type_id: vehicleTypeId,
      ...extra,
    },
    createDispatchRide: dispatch.createDispatchRide,
  });
  await dispatch.attachStudentRideToDispatch({ rideId: ride.rideId, studentRideId: ride.studentRideId });
  return ride;
};

const dispatchTo = async (rideId, liveStatus, status = 'ongoing') => {
  await Ride.updateOne({ _id: rideId }, { $set: { liveStatus, status, driverId } });
  const fresh = await Ride.findById(rideId);
  await syncStudentRideWithDispatch(fresh);
  return fresh;
};

const statusOf = async (id) => (await StudentRide.findById(id)).status;

/** Wrap a model method to count calls while `fn` runs. */
const spy = async (model, method, fn) => {
  const original = model[method];
  let calls = 0;
  model[method] = function spied(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    await fn();
  } finally {
    model[method] = original;
  }
  return calls;
};

console.log('\nTASK 2 — CANCEL AND UNMATCHED PATHS');

await check('an unmatched ride (findOneAndUpdate shape) cancels the student ride', async () => {
  const ride = await booked();

  // closeRideAsUnmatched uses findOneAndUpdate with no projection. The concern
  // is that the returned document might lack the fields the guard reads.
  const updated = await Ride.findOneAndUpdate(
    { _id: ride.rideId },
    { status: 'cancelled', liveStatus: 'cancelled', biddingStatus: 'expired' },
    { returnDocument: 'after' },
  );

  if (updated.serviceType !== 'student' || !updated.studentRideId) {
    throw new Error('findOneAndUpdate result is missing serviceType or studentRideId');
  }

  await syncStudentRideWithDispatch(updated);

  if (await statusOf(ride.studentRideId) !== 'CANCELLED') throw new Error('not cancelled');
  const events = await StudentRideEvent.find({ studentRideId: ride.studentRideId, eventType: 'RIDE_CANCELLED' });
  if (!events.length) throw new Error('no RIDE_CANCELLED event');
});

await check('admin cancellation cancels both documents', async () => {
  const ride = await booked();
  await dispatchService.cancelRideByAdmin(ride.rideId);

  const dispatchRide = await Ride.findById(ride.rideId);
  if (dispatchRide.status !== 'cancelled') throw new Error(`dispatch is ${dispatchRide.status}`);
  if (await statusOf(ride.studentRideId) !== 'CANCELLED') throw new Error('student ride not cancelled');
});

await check('cancelling from the student side does not loop', async () => {
  const ride = await booked();
  await rideService.cancelStudentRide({
    studentRideId: ride.studentRideId, userId: parent,
    cancelDispatchRide: dispatch.cancelDispatchRide,
  });

  const events = await StudentRideEvent.find({ studentRideId: ride.studentRideId, eventType: 'RIDE_CANCELLED' });
  // One from the student cancel; the sync that follows sees SETTLED and adds nothing.
  if (events.length !== 1) throw new Error(`${events.length} cancellation events, expected 1`);
});

console.log('\nTASK 4 — ONE EMIT PER STATUS');

await check('each crossed status is broadcast, in order', async () => {
  const ride = await booked();
  emitted.length = 0;

  await dispatchTo(ride.rideId, 'started');

  const statuses = emitted
    .filter((e) => e.event === 'student-ride:status:updated')
    .map((e) => e.payload.status);

  const expected = ['DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'PICKUP_OTP_VERIFIED', 'RIDE_STARTED'];
  if (JSON.stringify(statuses) !== JSON.stringify(expected)) {
    throw new Error(`got ${statuses.join(', ')}`);
  }
});

await check('student-ride:completed fires exactly once', async () => {
  const ride = await booked();
  emitted.length = 0;

  await dispatchTo(ride.rideId, 'completed', 'completed');

  const completions = emitted.filter((e) => e.event === 'student-ride:completed');
  if (completions.length !== 1) throw new Error(`${completions.length} completion events`);
});

console.log('\nTASK 3 — DROP OTP');

await check('reaching RIDE_STARTED mints the drop OTP', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'started');

  const doc = await StudentRide.findById(ride.studentRideId).select('+dropOtp.hash');
  if (!doc.dropOtp?.issuedAt) throw new Error('drop OTP not issued');
  if (!doc.dropOtp?.hash) throw new Error('no hash stored');
});

await check('a re-sync does not rotate the drop code', async () => {
  const ride = await booked();
  const dispatchRide = await dispatchTo(ride.rideId, 'started');
  const first = (await StudentRide.findById(ride.studentRideId).select('+dropOtp.hash')).dropOtp.hash;

  await syncStudentRideWithDispatch(dispatchRide);

  const second = (await StudentRide.findById(ride.studentRideId).select('+dropOtp.hash')).dropOtp.hash;
  if (first !== second) throw new Error('the code was rotated');
});

await check('the drop code goes to the parent only, never to the tracking room', async () => {
  const ride = await booked();
  emitted.length = 0;

  await dispatchTo(ride.rideId, 'started');

  const deliveries = emitted.filter((e) => e.event === 'student-ride:drop-otp');
  if (deliveries.length !== 1) throw new Error(`${deliveries.length} deliveries`);
  if (deliveries[0].room !== `user:${parent}`) throw new Error(`sent to ${deliveries[0].room}`);

  // A share-link viewer sits in student_ride:<id>. The code must not appear there.
  const leaked = emitted.some((e) => e.room.startsWith('student_ride:') && JSON.stringify(e.payload).includes(deliveries[0].payload.otp));
  if (leaked) throw new Error('drop code reached the tracking room');
});

await check('a genuinely verified drop no longer flags a bypass', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'started');

  const otp = emitted.filter((e) => e.event === 'student-ride:drop-otp').at(-1).payload.otp;

  await rideService.verifyRideOtp({
    studentRideId: ride.studentRideId, kind: 'drop', otp,
    actor: { role: 'driver', id: driverId },
    assertDriverForRide: dispatch.assertDriverForRide,
  });

  await dispatchTo(ride.rideId, 'completed', 'completed');

  const doc = await StudentRide.findById(ride.studentRideId);
  if (doc.otpBypassed.drop !== false) throw new Error('verified drop was flagged as bypassed');
});

console.log('\nTASK 6 — PICKUP OTP WINDOW');

await check('a ride scheduled 8 hours out still has a valid pickup code on arrival', async () => {
  const scheduledAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const ride = await booked({ scheduled_at: scheduledAt.toISOString() });

  const doc = await StudentRide.findById(ride.studentRideId);
  if (doc.pickupOtp.expiresAt.getTime() <= scheduledAt.getTime()) {
    throw new Error(`expires ${doc.pickupOtp.expiresAt.toISOString()}, before the ride is due`);
  }
});

console.log('\nTASK 5 — DRIVER PAYLOAD');

await check('a student ride carries the student block', async () => {
  const ride = await booked();
  const dispatchRide = await Ride.findById(ride.rideId);
  const block = studentDriverBlock(dispatchRide);

  if (block.student?.studentRideId !== ride.studentRideId) throw new Error('studentRideId missing');
  if (block.student.studentName !== 'Aarohi') throw new Error(`name was ${block.student.studentName}`);
  if (block.student.requiresPickupOtp !== true) throw new Error('requiresPickupOtp missing');
});

await check('the verification flags follow a real verification', async () => {
  const ride = await booked();
  await Ride.updateOne({ _id: ride.rideId }, { $set: { driverId } });
  await dispatchTo(ride.rideId, 'arriving');

  await rideService.verifyRideOtp({
    studentRideId: ride.studentRideId, kind: 'pickup', otp: ride.pickupOtp,
    actor: { role: 'driver', id: driverId },
    assertDriverForRide: dispatch.assertDriverForRide,
  });

  const block = studentDriverBlock(await Ride.findById(ride.rideId));
  if (block.student.pickupOtpVerified !== true) throw new Error('pickup verification not mirrored');
  if (block.student.dropOtpVerified !== false) throw new Error('drop wrongly marked');
});

console.log('\nTASK 10 — OPERATOR VISIBILITY');

await check('admin can filter to rides that bypassed a gate', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'completed', 'completed');

  const { results } = await adminService.listStudentRidesForAdmin({ bypassed: 'true' });
  if (!results.some((row) => row.studentRideId === ride.studentRideId)) {
    throw new Error('bypassed ride missing from the filter');
  }
  if (results.some((row) => !row.otpBypassed.pickup && !row.otpBypassed.drop)) {
    throw new Error('the filter returned a ride with no bypass');
  }
});

await check('admin ride detail includes the timeline', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'started');
  const detail = await adminService.getStudentRideForAdmin(ride.studentRideId);
  if (!detail.timeline.some((e) => e.eventType === 'PICKUP_OTP_BYPASSED')) throw new Error('bypass not in timeline');
});

console.log('\nNON-REGRESSION — NORMAL RIDES');

const normalRide = async (overrides = {}) => {
  const [ride] = await Ride.create([{
    userId: parent,
    pickupLocation: { type: 'Point', coordinates: [77.51, 28.46] },
    dropLocation: { type: 'Point', coordinates: [77.52, 28.47] },
    fare: 120, serviceType: 'ride', status: 'searching', liveStatus: 'searching',
    ...overrides,
  }]);
  return ride;
};

await check('a normal ride runs accept to complete with zero StudentRide reads', async () => {
  const ride = await normalRide();

  const reads = await spy(StudentRide, 'findById', async () => {
    for (const liveStatus of ['accepted', 'arriving', 'started', 'arrived', 'completed']) {
      await Ride.updateOne({ _id: ride._id }, { $set: { liveStatus, driverId } });
      await syncStudentRideWithDispatch(await Ride.findById(ride._id));
    }
  });

  if (reads !== 0) throw new Error(`${reads} StudentRide reads for a normal ride`);
});

await check('a parcel ride is ignored the same way', async () => {
  const ride = await normalRide({ serviceType: 'parcel', liveStatus: 'completed', status: 'completed' });
  const reads = await spy(StudentRide, 'findById', () => syncStudentRideWithDispatch(ride));
  if (reads !== 0) throw new Error(`${reads} StudentRide reads for a parcel`);
});

await check('a normal ride payload gains no student key', async () => {
  const ride = await normalRide();

  if (Object.keys(studentDriverBlock(ride)).length !== 0) throw new Error('block not empty for a normal ride');

  const realtime = coreRide.serializeRideRealtime(ride);
  if ('student' in realtime) throw new Error('realtime payload gained a student key');
});

await check('ride detail runs no count query (Task 8)', async () => {
  const ride = await normalRide({ driverId, status: 'ongoing', liveStatus: 'started' });
  const populated = await coreRide.getRideDetails(ride._id);

  let detail;
  const counts = await spy(Ride, 'countDocuments', async () => {
    detail = await coreRide.serializeRideDetail(populated);
  });

  if (counts !== 0) throw new Error(`${counts} countDocuments on ride detail`);
  if (detail.driver.totalTrips !== 152) throw new Error(`totalTrips was ${detail.driver.totalTrips}`);
});

console.log(`\n${pass} passed, ${fail} failed`);

await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
