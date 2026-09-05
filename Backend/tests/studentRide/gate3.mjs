/**
 * Student Ride — Gate 3: trip sharing, the public tracking payload and SOS.
 *
 *   node tests/studentRide/gate3.mjs
 *
 * The public payload gets the most attention here: it is the one response in
 * the system that anyone holding a forwarded link can read, so what it must
 * *not* contain is asserted explicitly rather than assumed from how it is built.
 */
import mongoose from 'mongoose';

const DB_NAME = `student_ride_g3_${Date.now()}`;
process.env.MONGODB_URI = process.env.STUDENT_RIDE_TEST_URI
  || `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
process.env.STUDENT_RIDE_SHARE_BASE_URL = 'https://yushigo.com';

const studentService = await import('../../src/modules/taxi/studentRide/services/studentService.js');
const locationService = await import('../../src/modules/taxi/studentRide/services/savedLocationService.js');
const rideService = await import('../../src/modules/taxi/studentRide/services/studentRideService.js');
const shareService = await import('../../src/modules/taxi/studentRide/services/shareService.js');
const emergencyService = await import('../../src/modules/taxi/studentRide/services/emergencyService.js');
const dispatch = await import('../../src/modules/taxi/studentRide/services/dispatchAdapter.js');
const { StudentRideShareToken } = await import('../../src/modules/taxi/studentRide/models/StudentRideShareToken.js');
const { StudentRideEvent } = await import('../../src/modules/taxi/studentRide/models/StudentRideEvent.js');
const { Ride } = await import('../../src/modules/taxi/user/models/Ride.js');
await import('../../src/modules/taxi/user/models/User.js');
await import('../../src/modules/taxi/driver/models/Driver.js');

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

for (const name of [
  'TaxiStudent', 'TaxiStudentGuardian', 'TaxiStudentSavedLocation',
  'TaxiStudentRide', 'TaxiStudentRideEvent', 'TaxiStudentRideShareToken',
  'TaxiStudentRideEmergency', 'TaxiRide', 'TaxiUser', 'TaxiDriver',
]) {
  await mongoose.model(name).createCollection().catch(() => null);
}
await mongoose.model('TaxiStudentRideShareToken').syncIndexes();

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
const driverId = new mongoose.Types.ObjectId();

// A driver with a phone number, so the public payload can be checked for leaks.
await mongoose.connection.collection('taxidrivers').insertOne({
  _id: driverId,
  name: 'Rakesh Kumar',
  phone: '9998887777',
  rating: 4.8,
  vehicleNumber: 'DL 12 AB 1234',
  vehicleMake: 'Maruti',
  vehicleModel: 'Ertiga',
  vehicleColor: 'White',
});

const student = await studentService.createStudent({
  userId: parent,
  payload: {
    name: 'Aarohi Sharma',
    dateOfBirth: '2014-08-12',
    phone: '9123456789',
    guardians: [{
      name: 'Varun Sharma', mobile: '9876543210', relationship: 'FATHER',
      email: 'varun@example.com', idType: 'AADHAAR', idReference: '1234-5678-9012',
    }],
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

const bookRide = async () => rideService.createStudentRide({
  userId: parent,
  payload: {
    student_id: student.id,
    pickup_saved_location_id: home.id,
    destination_saved_location_id: school.id,
  },
  createDispatchRide: dispatch.createDispatchRide,
});

const advanceTo = async (studentRideId, statuses) => {
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

/** A ride with a driver assigned and a known live position. */
const liveRide = async () => {
  const ride = await bookRide();
  await Ride.updateOne({ _id: ride.rideId }, {
    $set: {
      driverId,
      lastDriverLocation: { type: 'Point', coordinates: [77.515, 28.465] },
    },
  });
  await advanceTo(ride.studentRideId, ['DRIVER_ASSIGNED', 'DRIVER_ARRIVING']);
  return ride;
};

console.log('\nSHARE TOKENS (§26/§27/§52)');

const ride = await liveRide();
const share = await shareService.createShareLink({ studentRideId: ride.studentRideId, userId: parent });

await check('the share URL carries a long random token, not an id', async () => {
  const token = share.shareUrl.split('/').pop();
  if (token.length !== 64) throw new Error(`token length ${token.length}`);
  if (share.shareUrl.includes(ride.studentRideId)) throw new Error('internal id in the URL');
  if (share.shareUrl.includes(String(student.id))) throw new Error('student id in the URL');
  if (!share.shareUrl.startsWith('https://yushigo.com/')) throw new Error('base URL not from config');
});

await check('only a hash of the token is stored', async () => {
  const rows = await StudentRideShareToken.find({ studentRideId: ride.studentRideId });
  const raw = JSON.stringify(rows);
  if (raw.includes(share.token)) throw new Error('plaintext token stored');
  if (rows[0].tokenHash.length !== 64) throw new Error('not a sha256 hash');
});

await expectReject("another parent cannot share someone else's ride", 'RIDE_NOT_FOUND', () =>
  shareService.createShareLink({ studentRideId: ride.studentRideId, userId: otherParent }));

console.log('\nPUBLIC PAYLOAD (§30/§31)');

const publicView = await shareService.getPublicTracking(share.token);

await check('it returns what a watcher needs', async () => {
  if (!publicView.rideStatus) throw new Error('status missing');
  if (publicView.student?.displayName !== 'Aarohi') throw new Error(`displayName ${publicView.student?.displayName}`);
  if (publicView.driver?.name !== 'Rakesh Kumar') throw new Error('driver name missing');
  if (publicView.vehicle?.number !== 'DL 12 AB 1234') throw new Error('vehicle missing');
  if (publicView.currentLocation?.latitude !== 28.465) throw new Error('location missing');
});

await check('it leaks nothing private', async () => {
  const dump = JSON.stringify(publicView);

  const mustNotAppear = [
    ['student DOB', '2014-08-12'],
    ['student surname', 'Sharma'],
    ['student phone', '9123456789'],
    ['guardian name', 'Varun'],
    ['guardian phone', '9876543210'],
    ['guardian email', 'varun@example.com'],
    ['government ID', '1234-5678-9012'],
    ['driver phone', '9998887777'],
    ['internal student id', String(student.id)],
    ['internal ride id', String(ride.studentRideId)],
    ['internal user id', String(parent)],
    ['share token', share.token],
  ];

  for (const [label, value] of mustNotAppear) {
    if (dump.includes(value)) throw new Error(`${label} exposed publicly`);
  }
});

await check('an access is counted without blocking the read', async () => {
  await shareService.getPublicTracking(share.token);
  const [row] = await StudentRideShareToken.find({ studentRideId: ride.studentRideId });
  if (row.accessCount < 2) throw new Error(`accessCount ${row.accessCount}`);
  if (!row.lastAccessedAt) throw new Error('lastAccessedAt not recorded');
});

console.log('\nTOKEN LIFECYCLE (§32/§33)');

await expectReject('an unknown token is refused', 'RIDE_NOT_FOUND', () =>
  shareService.getPublicTracking('a'.repeat(64)));

await expectReject('a malformed token is refused the same way', 'RIDE_NOT_FOUND', () =>
  shareService.getPublicTracking('short'));

await check('every refusal is identical, so nothing can be probed', async () => {
  const messages = await Promise.all([
    shareService.getPublicTracking('b'.repeat(64)).catch((error) => error.message),
    shareService.getPublicTracking('not-a-token').catch((error) => error.message),
    shareService.getPublicTracking('').catch((error) => error.message),
  ]);

  if (new Set(messages).size !== 1) throw new Error(`messages differ: ${JSON.stringify(messages)}`);
});

await check('revoking kills the link immediately', async () => {
  const target = await liveRide();
  const link = await shareService.createShareLink({ studentRideId: target.studentRideId, userId: parent });
  await shareService.getPublicTracking(link.token);

  const [row] = await shareService.listShareLinks({ studentRideId: target.studentRideId, userId: parent });
  await shareService.revokeShareLink({
    studentRideId: target.studentRideId, shareId: row.shareId, userId: parent,
  });

  await shareService.getPublicTracking(link.token).then(
    () => { throw new Error('a revoked link still worked'); },
    (error) => {
      if (error.code !== 'RIDE_NOT_FOUND') throw new Error(`got ${error.code}`);
    },
  );
});

await check('an expired token stops working', async () => {
  const target = await liveRide();
  const link = await shareService.createShareLink({ studentRideId: target.studentRideId, userId: parent });

  await StudentRideShareToken.updateOne(
    { studentRideId: target.studentRideId },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );

  await shareService.getPublicTracking(link.token).then(
    () => { throw new Error('an expired link still worked'); },
    (error) => {
      if (error.code !== 'RIDE_NOT_FOUND') throw new Error(`got ${error.code}`);
    },
  );
});

await check('tracking stops when the ride completes (§65)', async () => {
  const target = await liveRide();
  const link = await shareService.createShareLink({ studentRideId: target.studentRideId, userId: parent });
  await shareService.getPublicTracking(link.token);

  await advanceTo(target.studentRideId, ['DRIVER_ARRIVED']);
  await rideService.verifyRideOtp({
    studentRideId: target.studentRideId, kind: 'pickup', otp: target.pickupOtp,
    actor: { role: 'driver', id: driverId },
    assertDriverForRide: dispatch.assertDriverForRide,
  });
  const started = await rideService.advanceStatus({
    studentRideId: target.studentRideId, nextStatus: 'RIDE_STARTED',
    actor: { role: 'driver', id: driverId }, expectDriverId: driverId,
    assertDriverForRide: dispatch.assertDriverForRide,
  });
  await rideService.verifyRideOtp({
    studentRideId: target.studentRideId, kind: 'drop', otp: started.dropOtp,
    actor: { role: 'driver', id: driverId },
    assertDriverForRide: dispatch.assertDriverForRide,
  });
  await advanceTo(target.studentRideId, ['COMPLETED']);

  // The token has not expired and was never revoked — the finished ride is what
  // closes the link.
  await shareService.getPublicTracking(link.token).then(
    () => { throw new Error('a completed ride still broadcast its location'); },
    (error) => {
      if (error.code !== 'RIDE_NOT_FOUND') throw new Error(`got ${error.code}`);
    },
  );
});

console.log('\nSOS (§37/§38/§39)');

let sosRide;

await check('an SOS is recorded with its location', async () => {
  sosRide = await liveRide();
  const emergency = await emergencyService.triggerSos({
    studentRideId: sosRide.studentRideId,
    actor: { role: 'user', id: parent },
    latitude: 28.6139,
    longitude: 77.2090,
    type: 'EMERGENCY',
  });

  if (emergency.status !== 'ACTIVE') throw new Error(`status ${emergency.status}`);
  if (emergency.latitude !== 28.6139) throw new Error('location not stored');
});

await check('the SOS appears in the ride timeline', async () => {
  const events = await StudentRideEvent.find({
    studentRideId: sosRide.studentRideId, eventType: 'SOS_TRIGGERED',
  });
  if (!events.length) throw new Error('SOS not audited');
});

await check('guardians marked as emergency contacts are reached', async () => {
  const target = await liveRide();
  let reached = null;

  await emergencyService.triggerSos({
    studentRideId: target.studentRideId,
    actor: { role: 'user', id: parent },
    latitude: 28.6, longitude: 77.2,
    notify: async ({ contacts }) => {
      reached = contacts;
      return contacts.length;
    },
  });

  if (!reached?.length) throw new Error('no contacts resolved');
  if (reached[0].mobile !== '9876543210') throw new Error('wrong contact');
});

await check('an SOS survives a notification failure', async () => {
  const target = await liveRide();
  const emergency = await emergencyService.triggerSos({
    studentRideId: target.studentRideId,
    actor: { role: 'user', id: parent },
    notify: async () => { throw new Error('SMS gateway down'); },
  });

  // The alert is the record that matters; delivery is best-effort.
  if (emergency.status !== 'ACTIVE') throw new Error('alert lost when notification failed');
});

await check('an SOS without coordinates is still accepted', async () => {
  const target = await liveRide();
  const emergency = await emergencyService.triggerSos({
    studentRideId: target.studentRideId,
    actor: { role: 'user', id: parent },
  });
  if (emergency.latitude !== null) throw new Error('expected null coordinates');
  if (emergency.status !== 'ACTIVE') throw new Error('alert refused without a fix');
});

await expectReject("another parent cannot raise an SOS on someone else's ride", 'RIDE_NOT_FOUND', () =>
  emergencyService.triggerSos({
    studentRideId: sosRide.studentRideId,
    actor: { role: 'user', id: otherParent },
  }));

await expectReject('an SOS cannot be raised on a ride that has not started', 'INVALID_RIDE_STATUS', async () => {
  const booked = await bookRide();
  return emergencyService.triggerSos({
    studentRideId: booked.studentRideId,
    actor: { role: 'user', id: parent },
  });
});

await check('an SOS can be resolved without erasing it', async () => {
  const [active] = await emergencyService.listRideEmergencies({
    studentRideId: sosRide.studentRideId, userId: parent,
  });

  const resolved = await emergencyService.resolveEmergency({
    emergencyId: active.emergencyId, userId: parent, notes: 'False alarm, child is safe.',
  });

  if (resolved.status !== 'RESOLVED') throw new Error(`status ${resolved.status}`);

  const stillThere = await emergencyService.listRideEmergencies({
    studentRideId: sosRide.studentRideId, userId: parent,
  });
  if (!stillThere.length) throw new Error('the record was removed');
});

console.log(`\n${pass} passed, ${fail} failed`);

await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
