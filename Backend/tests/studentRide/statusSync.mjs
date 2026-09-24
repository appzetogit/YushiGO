/**
 * Student Ride — dispatch status sync.
 *
 *   node tests/studentRide/statusSync.mjs
 *
 * The bug this covers: the driver app drives the dispatch ride, nothing carried
 * that onto the StudentRide companion, and the parent's app — which polls the
 * companion — sat on "finding driver" for the whole trip.
 */
import mongoose from 'mongoose';
import { approveStudent } from './_helpers.mjs';

const DB_NAME = `student_ride_sync_${Date.now()}`;
process.env.MONGODB_URI = process.env.STUDENT_RIDE_TEST_URI
  || `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';

const studentService = await import('../../src/modules/taxi/studentRide/services/studentService.js');
const locationService = await import('../../src/modules/taxi/studentRide/services/savedLocationService.js');
const rideService = await import('../../src/modules/taxi/studentRide/services/studentRideService.js');
const dispatch = await import('../../src/modules/taxi/studentRide/services/dispatchAdapter.js');
const { syncStudentRideWithDispatch } = await import('../../src/modules/taxi/studentRide/services/statusSyncService.js');
const { StudentRide } = await import('../../src/modules/taxi/studentRide/models/StudentRide.js');
const { StudentRideEvent } = await import('../../src/modules/taxi/studentRide/models/StudentRideEvent.js');
const { Ride } = await import('../../src/modules/taxi/user/models/Ride.js');
await import('../../src/modules/taxi/user/models/User.js');

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

for (const name of [
  'TaxiStudent', 'TaxiStudentGuardian', 'TaxiStudentSavedLocation',
  'TaxiStudentRide', 'TaxiStudentRideEvent', 'TaxiRide', 'TaxiUser',
]) {
  await mongoose.model(name).createCollection().catch(() => null);
}

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
await approveStudent(student.id);

const home = await locationService.createSavedLocation({
  studentId: student.id, userId: parent,
  payload: { label: 'HOME', address: 'Sector 36, Noida', latitude: 28.46, longitude: 77.51 },
});
const school = await locationService.createSavedLocation({
  studentId: student.id, userId: parent,
  payload: { label: 'SCHOOL', address: "St. Teresa's", latitude: 28.47, longitude: 77.52 },
});

const bookRide = async () => rideService.createStudentRide({
  userId: parent,
  payload: {
    student_id: student.id,
    pickup_saved_location_id: home.id,
    destination_saved_location_id: school.id,
    vehicle_type_id: vehicleTypeId,
  },
  createDispatchRide: dispatch.createDispatchRide,
});

/** Book, then link the two documents as the controller does. */
const booked = async () => {
  const ride = await bookRide();
  await Ride.updateOne({ _id: ride.rideId }, { $set: { studentRideId: ride.studentRideId } });
  return ride;
};

/** Drive the dispatch ride the way the driver app does, then sync. */
const dispatchTo = async (rideId, liveStatus, status = 'ongoing') => {
  await Ride.updateOne({ _id: rideId }, { $set: { liveStatus, status, driverId } });
  const fresh = await Ride.findById(rideId);
  await syncStudentRideWithDispatch(fresh);
  return fresh;
};

const statusOf = async (studentRideId) =>
  (await StudentRide.findById(studentRideId)).status;

const eventTypes = async (studentRideId) =>
  (await StudentRideEvent.find({ studentRideId }).sort({ createdAt: 1 })).map((e) => e.eventType);

console.log('\nTHE REPORTED BUG');

await check('a ride sits at BOOKED until something syncs it', async () => {
  const ride = await booked();
  if (await statusOf(ride.studentRideId) !== 'BOOKED') throw new Error('expected BOOKED');
});

await check('accepting the dispatch ride moves it to DRIVER_ASSIGNED', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'accepted', 'accepted');
  const status = await statusOf(ride.studentRideId);
  if (status !== 'DRIVER_ASSIGNED') throw new Error(`got ${status}`);
});

await check('completing from BOOKED walks the whole chain', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'completed', 'completed');

  const status = await statusOf(ride.studentRideId);
  if (status !== 'COMPLETED') throw new Error(`got ${status}`);

  // Every intermediate step is in the timeline, not just the destination.
  const types = await eventTypes(ride.studentRideId);
  for (const expected of ['DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'RIDE_STARTED', 'RIDE_COMPLETED']) {
    if (!types.includes(expected)) throw new Error(`${expected} missing from the timeline`);
  }

  const doc = await StudentRide.findById(ride.studentRideId);
  if (!doc.completedAt) throw new Error('completedAt not set');
});

console.log('\nSTEPPING');

await check('arriving maps to DRIVER_ARRIVED and passes through DRIVER_ARRIVING', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'arriving');

  const status = await statusOf(ride.studentRideId);
  if (status !== 'DRIVER_ARRIVED') throw new Error(`got ${status}`);

  const types = await eventTypes(ride.studentRideId);
  if (!types.includes('DRIVER_ARRIVING')) throw new Error('DRIVER_ARRIVING skipped in the timeline');
});

await check('arrived maps to NEAR_DESTINATION, not to completion', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'arrived');
  const status = await statusOf(ride.studentRideId);
  if (status !== 'NEAR_DESTINATION') throw new Error(`got ${status}`);
});

await check('a later dispatch status advances an already-synced ride', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'accepted', 'accepted');
  await dispatchTo(ride.rideId, 'started');
  const status = await statusOf(ride.studentRideId);
  if (status !== 'RIDE_STARTED') throw new Error(`got ${status}`);
});

console.log('\nIDEMPOTENCE AND SAFETY');

await check('re-syncing the same status changes nothing', async () => {
  const ride = await booked();
  const dispatchRide = await dispatchTo(ride.rideId, 'started');
  const firstCount = (await eventTypes(ride.studentRideId)).length;

  await syncStudentRideWithDispatch(dispatchRide);
  await syncStudentRideWithDispatch(dispatchRide);

  const afterCount = (await eventTypes(ride.studentRideId)).length;
  if (afterCount !== firstCount) throw new Error(`timeline grew ${firstCount} -> ${afterCount}`);
});

await check('the sync never runs backwards', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'completed', 'completed');
  // A stale dispatch document arriving late must not undo a finished ride.
  await Ride.updateOne({ _id: ride.rideId }, { $set: { liveStatus: 'accepted' } });
  await syncStudentRideWithDispatch(await Ride.findById(ride.rideId));

  const status = await statusOf(ride.studentRideId);
  if (status !== 'COMPLETED') throw new Error(`rolled back to ${status}`);
});

await check('a non-student ride is untouched', async () => {
  const [plain] = await Ride.create([{
    userId: parent,
    pickupLocation: { type: 'Point', coordinates: [77.51, 28.46] },
    dropLocation: { type: 'Point', coordinates: [77.52, 28.47] },
    fare: 100, serviceType: 'ride', liveStatus: 'completed', status: 'completed',
  }]);

  const result = await syncStudentRideWithDispatch(plain);
  if (result !== null) throw new Error('an ordinary ride was processed');
});

await check('a broken sync never fails the dispatch call', async () => {
  // A ride pointing at a StudentRide that no longer exists.
  const [orphan] = await Ride.create([{
    userId: parent,
    pickupLocation: { type: 'Point', coordinates: [77.51, 28.46] },
    dropLocation: { type: 'Point', coordinates: [77.52, 28.47] },
    fare: 100, serviceType: 'student', liveStatus: 'completed', status: 'completed',
    studentRideId: new mongoose.Types.ObjectId(),
  }]);

  const result = await syncStudentRideWithDispatch(orphan);
  if (result !== null) throw new Error('expected a quiet null');
});

console.log('\nCANCELLATION');

await check('a cancelled dispatch ride cancels the companion', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'accepted', 'accepted');
  await dispatchTo(ride.rideId, 'cancelled', 'cancelled');

  const doc = await StudentRide.findById(ride.studentRideId);
  if (doc.status !== 'CANCELLED') throw new Error(`got ${doc.status}`);
  if (!doc.cancelledAt) throw new Error('cancelledAt not set');
});

await check('a settled ride is not resurrected', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'cancelled', 'cancelled');
  await dispatchTo(ride.rideId, 'started');

  const status = await statusOf(ride.studentRideId);
  if (status !== 'CANCELLED') throw new Error(`got ${status}`);
});

console.log('\nTHE OTP GATES');

await check('an unverified pickup is recorded as bypassed, not as verified', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'started');

  const doc = await StudentRide.findById(ride.studentRideId);

  // The status advances so the parent's app moves on...
  if (doc.status !== 'RIDE_STARTED') throw new Error(`status ${doc.status}`);
  // ...but nothing claims a check happened.
  if (doc.pickupOtp.verifiedAt) throw new Error('the OTP was marked verified without a check');
  if (doc.otpBypassed.pickup !== true) throw new Error('bypass not flagged');

  const types = await eventTypes(ride.studentRideId);
  if (!types.includes('PICKUP_OTP_BYPASSED')) throw new Error('bypass not audited');
  if (types.includes('PICKUP_OTP_VERIFIED')) throw new Error('a verification was claimed');
});

await check('a genuinely verified pickup is not marked bypassed', async () => {
  const ride = await booked();
  await Ride.updateOne({ _id: ride.rideId }, { $set: { driverId } });
  await dispatchTo(ride.rideId, 'arriving');

  await rideService.verifyRideOtp({
    studentRideId: ride.studentRideId, kind: 'pickup', otp: ride.pickupOtp,
    actor: { role: 'driver', id: driverId },
    assertDriverForRide: dispatch.assertDriverForRide,
  });

  await dispatchTo(ride.rideId, 'started');

  const doc = await StudentRide.findById(ride.studentRideId);
  if (!doc.pickupOtp.verifiedAt) throw new Error('verification was lost');
  if (doc.otpBypassed.pickup !== false) throw new Error('a real verification was flagged as bypassed');
  if (doc.status !== 'RIDE_STARTED') throw new Error(`status ${doc.status}`);
});

await check('a completed trip with no codes flags both gates', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'completed', 'completed');

  const doc = await StudentRide.findById(ride.studentRideId);
  if (!doc.otpBypassed.pickup || !doc.otpBypassed.drop) {
    throw new Error(`pickup=${doc.otpBypassed.pickup} drop=${doc.otpBypassed.drop}`);
  }
});

await check('the bypass is visible through the API, not just in the database', async () => {
  const ride = await booked();
  await dispatchTo(ride.rideId, 'completed', 'completed');

  const detail = await rideService.getStudentRide({
    studentRideId: ride.studentRideId, userId: parent,
  });

  if (detail.otpBypassed?.pickup !== true) throw new Error('pickup bypass not surfaced');
  if (detail.otpBypassed?.drop !== true) throw new Error('drop bypass not surfaced');
  if (detail.pickupOtp.verified !== false) throw new Error('OTP reported as verified');
});


console.log('\nRESPONSE SHAPE');

await check('a student ride carries the driver and vehicle from the dispatch ride', async () => {
  const ride = await booked();
  await mongoose.connection.collection('taxidrivers').updateOne(
    { _id: driverId },
    {
      $set: {
        name: 'Rakesh Kumar', phone: '9998887777', rating: 4.8,
        vehicleNumber: 'MP09AB1234', vehicleMake: 'Maruti',
        vehicleModel: 'Swift', vehicleColor: 'White', vehicleType: 'car',
      },
    },
    { upsert: true },
  );
  await dispatchTo(ride.rideId, 'started');

  const detail = await rideService.getStudentRide({
    studentRideId: ride.studentRideId, userId: parent,
  });

  // The whole point: one call, not a merge of two.
  if (detail.driver?.name !== 'Rakesh Kumar') throw new Error('driver name missing');
  if (detail.driver?.phone !== '9998887777') throw new Error('driver phone missing');
  if (detail.vehicle?.plateNumber !== 'MP09AB1234') throw new Error('plate missing');
  if (detail.vehicle?.model !== 'Maruti Swift') throw new Error(`model was ${detail.vehicle?.model}`);
  if (typeof detail.driver?.totalTrips !== 'number') throw new Error('totalTrips missing');
  if (!detail.dispatch?.liveStatus) throw new Error('dispatch status missing');
  if (!(detail.fare > 0)) throw new Error('fare missing');

  // Existing keys are untouched.
  if (!detail.studentRideId || !detail.status || !detail.pickup) throw new Error('an existing field was dropped');
});

await check('driver is null while unassigned, not an empty object', async () => {
  const ride = await booked();
  const detail = await rideService.getStudentRide({
    studentRideId: ride.studentRideId, userId: parent,
  });

  if (detail.driver !== null) throw new Error(`expected null, got ${JSON.stringify(detail.driver)}`);
  if (detail.vehicle !== null) throw new Error('vehicle should be null too');
});

await check('the ride list carries the same summary', async () => {
  const rides = await rideService.listStudentRides({ userId: parent });
  if (!rides.length) throw new Error('no rides listed');
  if (!('dispatch' in rides[0])) throw new Error('summary missing from the list');
});


console.log(`\n${pass} passed, ${fail} failed`);

await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
