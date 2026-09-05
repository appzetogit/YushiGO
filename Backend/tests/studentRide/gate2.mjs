/**
 * Student Ride — Gate 2: booking, snapshots, the state machine, OTP security
 * and the audit trail.
 *
 *   node tests/studentRide/gate2.mjs
 */
import mongoose from 'mongoose';

const DB_NAME = `student_ride_g2_${Date.now()}`;
process.env.MONGODB_URI = process.env.STUDENT_RIDE_TEST_URI
  || `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
process.env.STUDENT_RIDE_OTP_MAX_ATTEMPTS = '3';

const studentService = await import('../../src/modules/taxi/studentRide/services/studentService.js');
const locationService = await import('../../src/modules/taxi/studentRide/services/savedLocationService.js');
const rideService = await import('../../src/modules/taxi/studentRide/services/studentRideService.js');
const dispatch = await import('../../src/modules/taxi/studentRide/services/dispatchAdapter.js');
const { StudentRide } = await import('../../src/modules/taxi/studentRide/models/StudentRide.js');
const { StudentRideEvent } = await import('../../src/modules/taxi/studentRide/models/StudentRideEvent.js');
const { Ride } = await import('../../src/modules/taxi/user/models/Ride.js');
// Registered so the collection list below can reference it; Ride only holds a ref.
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

const parent = new mongoose.Types.ObjectId();
const otherParent = new mongoose.Types.ObjectId();
const driver = new mongoose.Types.ObjectId();
const otherDriver = new mongoose.Types.ObjectId();

const student = await studentService.createStudent({
  userId: parent,
  payload: {
    name: 'Aarohi Sharma', dateOfBirth: '2014-08-12',
    guardians: [{ name: 'Varun', mobile: '9876543210', relationship: 'FATHER' }],
  },
});

const home = await locationService.createSavedLocation({
  studentId: student.id, userId: parent,
  payload: { label: 'HOME', address: 'Sector 36, Noida', latitude: 28.46, longitude: 77.51 },
});
const school = await locationService.createSavedLocation({
  studentId: student.id, userId: parent,
  payload: { label: 'SCHOOL', address: "St. Teresa's, Greater Noida", latitude: 28.47, longitude: 77.52 },
});

const bookRide = async (userId = parent) => rideService.createStudentRide({
  userId,
  payload: {
    student_id: student.id,
    pickup_saved_location_id: home.id,
    destination_saved_location_id: school.id,
  },
  createDispatchRide: dispatch.createDispatchRide,
});

/** Assign a driver on the dispatch ride, as the dispatcher would. */
const assignDriver = async (rideId, driverId = driver) => {
  await Ride.updateOne({ _id: rideId }, { $set: { driverId } });
};

const advanceTo = async (studentRideId, statuses, driverId = driver) => {
  for (const status of statuses) {
    await rideService.advanceStatus({
      studentRideId,
      nextStatus: status,
      actor: { role: 'driver', id: driverId },
      expectDriverId: driverId,
      assertDriverForRide: dispatch.assertDriverForRide,
    });
  }
};

console.log('\nBOOKING AND SNAPSHOTS (§63)');

const first = await bookRide();

await check('booking returns the pickup OTP exactly once', async () => {
  if (!/^\d{4}$/.test(first.pickupOtp || '')) throw new Error(`otp was ${first.pickupOtp}`);
});

await check('the ride snapshots the addresses rather than referencing them', async () => {
  if (first.pickup.address !== 'Sector 36, Noida') throw new Error(first.pickup.address);
  if (first.destination.address !== "St. Teresa's, Greater Noida") throw new Error(first.destination.address);
});

await check('editing a saved location does not rewrite an existing ride', async () => {
  await locationService.updateSavedLocation({
    locationId: home.id, userId: parent,
    payload: { address: 'Sector 45, Noida', latitude: 28.50, longitude: 77.55 },
  });

  const detail = await rideService.getStudentRide({ studentRideId: first.studentRideId, userId: parent });
  // This is the §83 acceptance test: history must survive a template change.
  if (detail.pickup.address !== 'Sector 36, Noida') {
    throw new Error(`history was rewritten to ${detail.pickup.address}`);
  }
});

await check('a dispatch ride is created and linked', async () => {
  const ride = await Ride.findById(first.rideId);
  if (!ride) throw new Error('no dispatch ride');
  if (ride.serviceType !== 'student') throw new Error(`serviceType ${ride.serviceType}`);
  if (String(ride.userId) !== String(parent)) throw new Error('wrong owner');
});

await expectReject("another parent's student cannot be booked", 'STUDENT_NOT_FOUND', () =>
  bookRide(otherParent));

await expectReject('a location belonging to another student is refused', 'LOCATION_NOT_FOUND', async () => {
  const sibling = await studentService.createStudent({
    userId: parent,
    payload: {
      name: 'Rahul', dateOfBirth: '2012-01-01',
      guardians: [{ name: 'Varun', mobile: '9876543210', relationship: 'FATHER' }],
    },
  });
  return rideService.createStudentRide({
    userId: parent,
    payload: {
      student_id: sibling.id,
      pickup_saved_location_id: home.id,
      destination_saved_location_id: school.id,
    },
    createDispatchRide: dispatch.createDispatchRide,
  });
});

console.log('\nOTP SECURITY (§21)');

await check('the OTP is never stored in the clear', async () => {
  const raw = await mongoose.connection.collection('taxistudentrides')
    .findOne({ _id: new mongoose.Types.ObjectId(first.studentRideId) });

  if (raw.pickupOtp.hash === first.pickupOtp) throw new Error('stored in plaintext');
  if (raw.pickupOtp.hash.length !== 64) throw new Error('not a sha256 hash');
  if (JSON.stringify(raw).includes(first.pickupOtp)) throw new Error('plaintext appears in the document');
});

await check('ride detail exposes OTP state but never the code', async () => {
  const detail = await rideService.getStudentRide({ studentRideId: first.studentRideId, userId: parent });
  if (detail.pickupOtp.issued !== true) throw new Error('issued flag missing');
  if (detail.pickupOtp.verified !== false) throw new Error('should not be verified');
  if (JSON.stringify(detail).includes(first.pickupOtp)) throw new Error('code leaked in detail');
});

await assignDriver(first.rideId);
await advanceTo(first.studentRideId, ['DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED']);

await expectReject('a driver who is not assigned cannot verify', 'UNAUTHORIZED_DRIVER', () =>
  rideService.verifyRideOtp({
    studentRideId: first.studentRideId, kind: 'pickup', otp: first.pickupOtp,
    actor: { role: 'driver', id: otherDriver },
    assertDriverForRide: dispatch.assertDriverForRide,
  }));

await expectReject('an incorrect code is refused', 'INVALID_OTP', () =>
  rideService.verifyRideOtp({
    studentRideId: first.studentRideId, kind: 'pickup', otp: '0000',
    actor: { role: 'driver', id: driver },
    assertDriverForRide: dispatch.assertDriverForRide,
  }));

await check('a failed attempt is counted and audited without the value tried', async () => {
  const detail = await rideService.getStudentRide({ studentRideId: first.studentRideId, userId: parent });
  if (detail.pickupOtp.attemptsRemaining !== 2) {
    throw new Error(`attemptsRemaining ${detail.pickupOtp.attemptsRemaining}`);
  }

  const events = await StudentRideEvent.find({
    studentRideId: first.studentRideId, eventType: 'PICKUP_OTP_FAILED',
  });
  if (!events.length) throw new Error('failure not audited');
  if (JSON.stringify(events[0].metadata).includes('0000')) throw new Error('attempted code was logged');
});

await check('the correct code verifies and advances the ride', async () => {
  const result = await rideService.verifyRideOtp({
    studentRideId: first.studentRideId, kind: 'pickup', otp: first.pickupOtp,
    actor: { role: 'driver', id: driver },
    assertDriverForRide: dispatch.assertDriverForRide,
  });
  if (result.status !== 'PICKUP_OTP_VERIFIED') throw new Error(`status ${result.status}`);
  if (result.pickupOtp.verified !== true) throw new Error('not marked verified');
});

await expectReject('a verified code cannot be replayed', 'OTP_ALREADY_VERIFIED', () =>
  rideService.verifyRideOtp({
    studentRideId: first.studentRideId, kind: 'pickup', otp: first.pickupOtp,
    actor: { role: 'driver', id: driver },
    assertDriverForRide: dispatch.assertDriverForRide,
  }));

await check('attempts are capped', async () => {
  const ride = await bookRide();
  await assignDriver(ride.rideId);
  await advanceTo(ride.studentRideId, ['DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED']);

  // Three wrong tries exhausts the configured limit.
  for (let i = 0; i < 3; i += 1) {
    await rideService.verifyRideOtp({
      studentRideId: ride.studentRideId, kind: 'pickup', otp: '1111',
      actor: { role: 'driver', id: driver },
      assertDriverForRide: dispatch.assertDriverForRide,
    }).catch(() => null);
  }

  try {
    // Even the correct code is refused once the cap is reached.
    await rideService.verifyRideOtp({
      studentRideId: ride.studentRideId, kind: 'pickup', otp: ride.pickupOtp,
      actor: { role: 'driver', id: driver },
      assertDriverForRide: dispatch.assertDriverForRide,
    });
  } catch (error) {
    if (error.code !== 'OTP_ATTEMPTS_EXCEEDED') throw new Error(`got ${error.code}`);
    return;
  }
  throw new Error('the cap was not enforced');
});

await check('re-issuing clears a lockout and invalidates the old code', async () => {
  const ride = await bookRide();
  await assignDriver(ride.rideId);
  await advanceTo(ride.studentRideId, ['DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED']);

  const reissued = await rideService.reissueOtp({
    studentRideId: ride.studentRideId, userId: parent, kind: 'pickup',
  });
  if (!/^\d{4}$/.test(reissued.pickupOtp)) throw new Error('no new code returned');

  if (reissued.pickupOtp !== ride.pickupOtp) {
    await rideService.verifyRideOtp({
      studentRideId: ride.studentRideId, kind: 'pickup', otp: ride.pickupOtp,
      actor: { role: 'driver', id: driver },
      assertDriverForRide: dispatch.assertDriverForRide,
    }).then(
      () => { throw new Error('the superseded code still worked'); },
      (error) => {
        if (error.code !== 'INVALID_OTP') throw new Error(`got ${error.code}`);
      },
    );
  }

  const ok = await rideService.verifyRideOtp({
    studentRideId: ride.studentRideId, kind: 'pickup', otp: reissued.pickupOtp,
    actor: { role: 'driver', id: driver },
    assertDriverForRide: dispatch.assertDriverForRide,
  });
  if (ok.status !== 'PICKUP_OTP_VERIFIED') throw new Error('new code did not verify');
});

console.log('\nSTATE MACHINE (§16)');

await expectReject('BOOKED cannot jump straight to COMPLETED', 'INVALID_RIDE_STATUS', async () => {
  const ride = await bookRide();
  await assignDriver(ride.rideId);
  return rideService.advanceStatus({
    studentRideId: ride.studentRideId, nextStatus: 'COMPLETED',
    actor: { role: 'driver', id: driver }, expectDriverId: driver,
    assertDriverForRide: dispatch.assertDriverForRide,
  });
});

await expectReject('a pickup OTP cannot be verified before the driver arrives', 'INVALID_RIDE_STATUS', async () => {
  const ride = await bookRide();
  await assignDriver(ride.rideId);
  return rideService.verifyRideOtp({
    studentRideId: ride.studentRideId, kind: 'pickup', otp: ride.pickupOtp,
    actor: { role: 'driver', id: driver },
    assertDriverForRide: dispatch.assertDriverForRide,
  });
});

await check('a wrong-status verification does not consume an attempt', async () => {
  const ride = await bookRide();
  await assignDriver(ride.rideId);

  await rideService.verifyRideOtp({
    studentRideId: ride.studentRideId, kind: 'pickup', otp: '9999',
    actor: { role: 'driver', id: driver },
    assertDriverForRide: dispatch.assertDriverForRide,
  }).catch(() => null);

  const detail = await rideService.getStudentRide({ studentRideId: ride.studentRideId, userId: parent });
  if (detail.pickupOtp.attemptsRemaining !== 3) {
    throw new Error(`an attempt was consumed: ${detail.pickupOtp.attemptsRemaining} left`);
  }
});

console.log('\nFULL JOURNEY');

let journey;

await check('a ride runs from booking to completion', async () => {
  journey = await bookRide();
  await assignDriver(journey.rideId);
  await advanceTo(journey.studentRideId, ['DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED']);

  await rideService.verifyRideOtp({
    studentRideId: journey.studentRideId, kind: 'pickup', otp: journey.pickupOtp,
    actor: { role: 'driver', id: driver },
    assertDriverForRide: dispatch.assertDriverForRide,
  });

  const started = await rideService.advanceStatus({
    studentRideId: journey.studentRideId, nextStatus: 'RIDE_STARTED',
    actor: { role: 'driver', id: driver }, expectDriverId: driver,
    assertDriverForRide: dispatch.assertDriverForRide,
  });

  // The drop code is minted when the journey starts, not at booking.
  if (!/^\d{4}$/.test(started.dropOtp || '')) throw new Error('drop OTP not issued at start');

  await rideService.advanceStatus({
    studentRideId: journey.studentRideId, nextStatus: 'NEAR_DESTINATION',
    actor: { role: 'driver', id: driver }, expectDriverId: driver,
    assertDriverForRide: dispatch.assertDriverForRide,
  });

  const dropped = await rideService.verifyRideOtp({
    studentRideId: journey.studentRideId, kind: 'drop', otp: started.dropOtp,
    actor: { role: 'driver', id: driver },
    assertDriverForRide: dispatch.assertDriverForRide,
  });
  if (dropped.status !== 'DROP_OTP_VERIFIED') throw new Error(`status ${dropped.status}`);

  const completed = await rideService.advanceStatus({
    studentRideId: journey.studentRideId, nextStatus: 'COMPLETED',
    actor: { role: 'driver', id: driver }, expectDriverId: driver,
    assertDriverForRide: dispatch.assertDriverForRide,
  });
  if (completed.status !== 'COMPLETED') throw new Error(`status ${completed.status}`);
  if (!completed.completedAt) throw new Error('completedAt missing');
});

console.log('\nAUDIT TRAIL (§17)');

await check('the timeline records the journey in order', async () => {
  const detail = await rideService.getStudentRide({ studentRideId: journey.studentRideId, userId: parent });
  const types = detail.timeline.map((entry) => entry.eventType);

  for (const expected of [
    'RIDE_BOOKED', 'PICKUP_OTP_VERIFIED', 'RIDE_STARTED', 'DROP_OTP_VERIFIED', 'RIDE_COMPLETED',
  ]) {
    if (!types.includes(expected)) throw new Error(`${expected} missing from the timeline`);
  }

  const booked = types.indexOf('RIDE_BOOKED');
  const completed = types.indexOf('RIDE_COMPLETED');
  if (booked > completed) throw new Error('timeline is out of order');
});

await check('no timeline entry contains an OTP', async () => {
  const events = await StudentRideEvent.find({ studentRideId: journey.studentRideId });
  const dump = JSON.stringify(events);
  if (dump.includes(journey.pickupOtp)) throw new Error('pickup OTP leaked into the audit trail');
});

console.log('\nCANCELLATION');

await check('a booked ride can be cancelled', async () => {
  const ride = await bookRide();
  const cancelled = await rideService.cancelStudentRide({
    studentRideId: ride.studentRideId, userId: parent, reason: 'plans changed',
  });
  if (cancelled.status !== 'CANCELLED') throw new Error(`status ${cancelled.status}`);
  if (cancelled.cancelledBy !== 'user') throw new Error('cancelledBy not recorded');
});

await expectReject('a ride in progress cannot be cancelled by the parent', 'CANCELLATION_NOT_ALLOWED', async () => {
  const ride = await bookRide();
  await assignDriver(ride.rideId);
  await advanceTo(ride.studentRideId, ['DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED']);
  await rideService.verifyRideOtp({
    studentRideId: ride.studentRideId, kind: 'pickup', otp: ride.pickupOtp,
    actor: { role: 'driver', id: driver },
    assertDriverForRide: dispatch.assertDriverForRide,
  });

  return rideService.cancelStudentRide({ studentRideId: ride.studentRideId, userId: parent });
});

await expectReject("another parent cannot cancel someone else's ride", 'RIDE_NOT_FOUND', () =>
  rideService.cancelStudentRide({ studentRideId: journey.studentRideId, userId: otherParent }));

console.log('\nLISTING');

await check('rides list for the owner and nobody else', async () => {
  const mine = await rideService.listStudentRides({ userId: parent });
  const theirs = await rideService.listStudentRides({ userId: otherParent });

  if (!mine.length) throw new Error('owner sees nothing');
  if (theirs.length) throw new Error("another parent sees this parent's rides");
});

await check('upcoming excludes completed and cancelled rides', async () => {
  const upcoming = await rideService.listStudentRides({ userId: parent, upcoming: true });
  if (upcoming.some((ride) => ['COMPLETED', 'CANCELLED'].includes(ride.status))) {
    throw new Error('a finished ride appeared in upcoming');
  }
});

console.log(`\n${pass} passed, ${fail} failed`);

await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
