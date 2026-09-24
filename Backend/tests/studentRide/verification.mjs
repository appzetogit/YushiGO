/**
 * Student Ride — identity, admin verification, the booking gate, Aadhaar via
 * the provider seam, multi-child rides and the no-bike rule.
 *
 *   node tests/studentRide/verification.mjs
 */
import mongoose from 'mongoose';
import { approveStudent } from './_helpers.mjs';

const DB_NAME = `student_verification_${Date.now()}`;
process.env.MONGODB_URI = process.env.STUDENT_RIDE_TEST_URI
  || `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
process.env.NODE_ENV = 'test';

const studentService = await import('../../src/modules/taxi/studentRide/services/studentService.js');
const identity = await import('../../src/modules/taxi/studentRide/services/studentIdentityService.js');
const aadhaar = await import('../../src/modules/taxi/studentRide/services/aadhaarService.js');
const admin = await import('../../src/modules/taxi/studentRide/services/adminStudentVerificationService.js');
const locationService = await import('../../src/modules/taxi/studentRide/services/savedLocationService.js');
const rideService = await import('../../src/modules/taxi/studentRide/services/studentRideService.js');
const settingsService = await import('../../src/modules/taxi/studentRide/services/studentRideSettings.js');
const dispatch = await import('../../src/modules/taxi/studentRide/services/dispatchAdapter.js');
const { migrateStudentVerification } = await import('../../scripts/migrateStudentVerification.js');
const { Student } = await import('../../src/modules/taxi/studentRide/models/Student.js');
const { StudentRide } = await import('../../src/modules/taxi/studentRide/models/StudentRide.js');
await import('../../src/modules/taxi/user/models/Ride.js');
await import('../../src/modules/taxi/user/models/User.js');
await import('../../src/modules/taxi/admin/models/AdminThirdPartySetting.js');
await import('../../src/modules/taxi/admin/models/AdminBusinessSetting.js');

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

for (const name of [
  'TaxiStudent', 'TaxiStudentGuardian', 'TaxiStudentSavedLocation', 'TaxiStudentRide',
  'TaxiStudentRideEvent', 'TaxiRide', 'TaxiUser', 'TaxiAdminThirdPartySetting', 'TaxiAdminBusinessSetting',
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
const adminId = new mongoose.Types.ObjectId();
await mongoose.connection.collection('taxiusers').insertMany([
  { _id: parent, name: 'Varun', gender: 'male' },
  { _id: otherParent, name: 'Other' },
]);

const car = new mongoose.Types.ObjectId();
const bike = new mongoose.Types.ObjectId();
const flaggedAuto = new mongoose.Types.ObjectId();
await mongoose.connection.collection('taxivehicles').insertMany([
  { _id: car, name: 'YushiGo Fast', icon_types: 'car', transport_type: 'taxi', status: 1, service_tax: 0 },
  { _id: bike, name: 'Bike Go', icon_types: 'bike', transport_type: 'taxi', status: 1, service_tax: 0 },
  { _id: flaggedAuto, name: 'Texi Go', icon_types: 'auto', transport_type: 'taxi', status: 1, service_tax: 0, allowed_for_student_ride: false },
]);
for (const vehicle of [car, bike, flaggedAuto]) {
  await mongoose.connection.collection('taxisetprices').insertOne({
    vehicle_type: vehicle, transport_type: 'taxi', active: 1, status: 'active',
    zone_id: null, service_location_id: null, base_price: 30, base_distance: 2, price_per_distance: 12, service_tax: 0,
  });
}

// A valid Aadhaar-format number (Verhoeff checksum) — synthetic, not a real person's.
const VALID_AADHAAR = '234123412346';

const guardians = [{ name: 'Varun', mobile: '9876543210', relationship: 'FATHER' }];
const newStudent = (extra = {}) => studentService.createStudent({
  userId: parent,
  payload: { name: 'Aarohi Sharma', dateOfBirth: '2014-08-12', guardians, ...extra },
});

console.log('\nIDENTITY');

await check('a new student starts PENDING with a child age category', async () => {
  const student = await newStudent();
  if (student.verificationStatus !== 'PENDING') throw new Error(student.verificationStatus);
  if (student.ageCategory !== 'child') throw new Error(student.ageCategory);
});

await expectReject('an Aadhaar number with a bad checksum is refused', 'INVALID_AADHAAR', () =>
  newStudent({ aadhaarNumber: '234123412345' }));

await check('the Aadhaar number is stored encrypted and only the last four come back', async () => {
  const student = await newStudent({ aadhaarNumber: '2341 2341 2346', studentIdNumber: 'STP-1042' });
  if (student.aadhaar.last4 !== '2346' || student.aadhaar.masked !== 'XXXX XXXX 2346') throw new Error(JSON.stringify(student.aadhaar));
  if (JSON.stringify(student).includes(VALID_AADHAAR)) throw new Error('full number in the response');

  const raw = await mongoose.connection.collection('taxistudents').findOne({ _id: new mongoose.Types.ObjectId(student.id) });
  if (JSON.stringify(raw).includes(VALID_AADHAAR)) throw new Error('full number stored in the clear');
  if (!raw.aadhaar.encrypted || !raw.aadhaar.lookup) throw new Error('encrypted copy or lookup missing');
});

console.log('\nTHE BOOKING GATE');

const pending = await newStudent();

await expectReject('a pending student cannot get a saved location', 'STUDENT_NOT_VERIFIED', () =>
  locationService.createSavedLocation({
    studentId: pending.id, userId: parent,
    payload: { label: 'HOME', address: 'Sector 36', latitude: 28.46, longitude: 77.51 },
  }));

await expectReject('a pending student cannot be quoted', 'STUDENT_NOT_VERIFIED', () =>
  rideService.resolveRideEndpointsForQuote({
    userId: parent,
    payload: { student_id: pending.id, pickup: { address: 'A', latitude: 28.46, longitude: 77.51 }, destination: { address: 'B', latitude: 28.47, longitude: 77.52 } },
  }));

await check('a pending student profile can still be viewed and edited', async () => {
  await studentService.getStudent({ studentId: pending.id, userId: parent });
  const updated = await studentService.updateStudent({ studentId: pending.id, userId: parent, payload: { schoolName: 'DPS' } });
  if (updated.schoolName !== 'DPS') throw new Error('edit failed');
});

console.log('\nADMIN REVIEW');

await check('the pending list includes the student with counts', async () => {
  const list = await admin.listStudentsForAdmin({ status: 'PENDING' });
  if (!list.results.some((s) => s.id === pending.id)) throw new Error('not listed');
  if (!(list.counts.PENDING >= 1)) throw new Error(JSON.stringify(list.counts));
});

await expectReject('rejecting needs a reason', 'INVALID_REVIEW', () =>
  admin.rejectStudent({ studentId: pending.id, adminId, reason: '' }));

await check('rejection is recorded and explained to the parent at booking', async () => {
  await admin.rejectStudent({ studentId: pending.id, adminId, reason: 'School ID photo unreadable' });
  const doc = await Student.findById(pending.id);
  if (doc.verificationStatus !== 'REJECTED' || doc.rejectionReason !== 'School ID photo unreadable') throw new Error('not recorded');

  let message = '';
  await locationService.createSavedLocation({
    studentId: pending.id, userId: parent, payload: { label: 'HOME', address: 'x', latitude: 28.46, longitude: 77.51 },
  }).catch((error) => { message = error.message; });
  if (!message.includes('School ID photo unreadable')) throw new Error(message);
});

await check('resubmitting changed identity details sends a rejected student back to PENDING', async () => {
  const updated = await studentService.updateStudent({
    studentId: pending.id, userId: parent, payload: { studentIdPhotoUrl: 'https://cdn/id-new.jpg' },
  });
  if (updated.verificationStatus !== 'PENDING' || updated.rejectionReason) throw new Error(updated.verificationStatus);
});

await check('approval opens the gate', async () => {
  const result = await admin.approveStudent({ studentId: pending.id, adminId });
  if (result.verificationStatus !== 'VERIFIED') throw new Error(result.verificationStatus);
  await locationService.createSavedLocation({
    studentId: pending.id, userId: parent, payload: { label: 'HOME', address: 'x', latitude: 28.46, longitude: 77.51 },
  });
});

await check('editing the school keeps a verified student verified; editing the name does not', async () => {
  let s = await studentService.updateStudent({ studentId: pending.id, userId: parent, payload: { className: '9-B' } });
  if (s.verificationStatus !== 'VERIFIED') throw new Error('class edit reset verification');
  s = await studentService.updateStudent({ studentId: pending.id, userId: parent, payload: { name: 'Someone Else' } });
  if (s.verificationStatus !== 'PENDING') throw new Error('name change kept verification');
});

await check('re-posting the same Aadhaar number is not an identity change', async () => {
  const s = await newStudent({ aadhaarNumber: VALID_AADHAAR });
  await approveStudent(s.id);
  const after = await studentService.updateStudent({ studentId: s.id, userId: parent, payload: { aadhaarNumber: VALID_AADHAAR } });
  if (after.verificationStatus !== 'VERIFIED') throw new Error('same number reset verification');
});

console.log('\nAADHAAR VIA THE PROVIDER');

await expectReject('with no provider configured the endpoints say so', 'AADHAAR_PROVIDER_NOT_CONFIGURED', async () => {
  const s = await newStudent();
  return aadhaar.initiateAadhaarVerification({ userId: parent, payload: { student_id: s.id, aadhaar_number: VALID_AADHAAR } });
});

await check('sandbox provider: OTP flow replaces the DOB with the provider\'s and locks it', async () => {
  await mongoose.connection.collection('taxiadminthirdpartysettings').updateOne(
    { scope: 'default' },
    { $set: { kyc: { aadhaar: { enabled: true, provider: 'sandbox', sandbox: { dob: '2013-01-05', name: 'Aarohi S' } } } } },
    { upsert: true },
  );

  const s = await newStudent({ dateOfBirth: '2014-08-12' });
  const started = await aadhaar.initiateAadhaarVerification({ userId: parent, payload: { student_id: s.id, aadhaar_number: VALID_AADHAAR } });
  if (!started.otpSent || started.last4 !== '2346') throw new Error(JSON.stringify(started));

  let wrong = null;
  await aadhaar.verifyAadhaarOtp({ userId: parent, payload: { student_id: s.id, otp: '000000' } }).catch((e) => { wrong = e.code; });
  if (wrong !== 'AADHAAR_VERIFICATION_FAILED') throw new Error(`wrong otp -> ${wrong}`);

  const verified = await aadhaar.verifyAadhaarOtp({ userId: parent, payload: { student_id: s.id, otp: '123456' } });
  if (!verified.aadhaar.verified) throw new Error('not verified');
  if (new Date(verified.dateOfBirth).toISOString().slice(0, 10) !== '2013-01-05') throw new Error(`dob ${verified.dateOfBirth}`);

  let locked = null;
  await studentService.updateStudent({ studentId: s.id, userId: parent, payload: { dateOfBirth: '2010-01-01' } })
    .catch((e) => { locked = e.code; });
  if (locked !== 'DOB_LOCKED') throw new Error(`dob edit -> ${locked}`);

  // The edit form re-posting the same DOB is not refused.
  await studentService.updateStudent({ studentId: s.id, userId: parent, payload: { dateOfBirth: '2013-01-05', schoolName: 'KV' } });
});

await check('the sandbox provider is refused in production', async () => {
  process.env.NODE_ENV = 'production';
  let code = null;
  await aadhaar.resolveAadhaarProvider().catch((e) => { code = e.code; });
  process.env.NODE_ENV = 'test';
  if (code !== 'AADHAAR_PROVIDER_NOT_CONFIGURED') throw new Error(`got ${code}`);
});

await check('the admin sees duplicates of the same Aadhaar across records', async () => {
  const list = await admin.listStudentsForAdmin({});
  const withDup = list.results.find((s) => s.aadhaar.last4 === '2346');
  if (!withDup || withDup.aadhaarDuplicates < 1) throw new Error('duplicate not flagged');
});

console.log('\nVEHICLES — NEVER A BIKE');

await check('two-wheelers are refused by default, admin flags win', () => {
  const allowed = settingsService.vehicleAllowedForStudentRide;
  if (!allowed({ name: 'YushiGo Fast', icon_types: 'car' })) throw new Error('car refused');
  if (allowed({ name: 'Bike Go', icon_types: 'bike' })) throw new Error('bike allowed');
  if (allowed({ name: 'Go Scooty', icon_types: 'car' })) throw new Error('scooty allowed');
  if (!allowed({ name: 'Texi Go', icon_types: 'auto' })) throw new Error('auto refused by default');
  if (allowed({ name: 'Texi Go', icon_types: 'auto', allowed_for_student_ride: false })) throw new Error('flag ignored');
  if (!allowed({ name: 'Bike Go', icon_types: 'bike', allowed_for_student_ride: true })) throw new Error('explicit allow ignored');
});

console.log('\nMULTI-CHILD RIDES');

const s1 = await newStudent({ name: 'Aarohi' });
const s2 = await newStudent({ name: 'Kabir' });
const s3 = await newStudent({ name: 'Mira' });
for (const s of [s1, s2, s3]) await approveStudent(s.id);
const home = await locationService.createSavedLocation({ studentId: s1.id, userId: parent, payload: { label: 'HOME', address: 'Sector 36', latitude: 28.46, longitude: 77.51 } });
const school = await locationService.createSavedLocation({ studentId: s2.id, userId: parent, payload: { label: 'SCHOOL', address: 'School', latitude: 28.47, longitude: 77.52 } });

const book = (payload) => rideService.createStudentRide({
  userId: parent,
  payload: { vehicle_type_id: car, pickup_saved_location_id: home.id, destination_saved_location_id: school.id, ...payload },
  createDispatchRide: dispatch.createDispatchRide,
});

await expectReject('a bike cannot be booked for a student', 'VEHICLE_NOT_ALLOWED', () =>
  book({ student_id: s1.id, pickup_saved_location_id: undefined, destination_saved_location_id: undefined,
    pickup: { address: 'A', latitude: 28.46, longitude: 77.51 }, destination: { address: 'B', latitude: 28.47, longitude: 77.52 }, vehicle_type_id: bike }));

await check('two siblings on one ride, flat fare by default, one pickup code', async () => {
  const single = await book({ student_id: s1.id, pickup_saved_location_id: undefined, destination_saved_location_id: undefined,
    pickup: { address: 'A', latitude: 28.46, longitude: 77.51 }, destination: { address: 'B', latitude: 28.47, longitude: 77.52 } });
  const both = await book({ student_ids: [s1.id, s2.id] });

  if (both.studentIds.length !== 2 || both.students.length !== 2) throw new Error(JSON.stringify(both.studentIds));
  if (both.student.id !== s1.id) throw new Error('primary student changed');
  if (!/^\d{4}$/.test(both.pickupOtp)) throw new Error('no single pickup code');
  if (both.fare !== single.fare) throw new Error(`flat fare changed: ${both.fare} vs ${single.fare}`);

  const doc = await StudentRide.findById(both.studentRideId);
  if (doc.studentIds.length !== 2 || String(doc.studentId) !== s1.id) throw new Error('not stored');
});

await check('per-child fare applies the admin percentage', async () => {
  await mongoose.connection.collection('taxiadminbusinesssettings').updateOne(
    { scope: 'default' },
    { $set: { student_ride: { multi_child_fare_mode: 'per_child', extra_child_fare_percent: 50, max_children_per_ride: 2 } } },
    { upsert: true },
  );
  // Same inline addresses for both, so only the child count differs.
  const inline = {
    pickup_saved_location_id: undefined, destination_saved_location_id: undefined,
    pickup: { address: 'A', latitude: 28.46, longitude: 77.51 }, destination: { address: 'B', latitude: 28.47, longitude: 77.52 },
  };
  const one = await book({ student_ids: [s1.id], ...inline });
  const two = await book({ student_ids: [s1.id, s2.id], ...inline });
  if (Math.abs(two.fare - one.fare * 1.5) > 0.01) throw new Error(`${two.fare} vs ${one.fare}`);
});

await expectReject('more children than the admin allows is refused', 'TOO_MANY_STUDENTS', () =>
  book({ student_ids: [s1.id, s2.id, s3.id] }));

await expectReject('an unverified sibling blocks the whole booking', 'STUDENT_NOT_VERIFIED', async () => {
  const unverified = await newStudent({ name: 'Tara' });
  return book({ student_ids: [s1.id, unverified.id] });
});

await expectReject('another parent\'s child cannot be added to a ride', 'STUDENT_NOT_FOUND', async () => {
  const theirs = await studentService.createStudent({ userId: otherParent, payload: { name: 'Zoe', dateOfBirth: '2014-01-01', guardians } });
  await approveStudent(theirs.id);
  return book({ student_ids: [s1.id, theirs.id] });
});

await expectReject('a saved location of a child not on the ride is refused', 'LOCATION_NOT_FOUND', () =>
  book({ student_ids: [s1.id, s3.id], destination_saved_location_id: school.id }));

await check('a sibling sees the shared ride in their own ride list', async () => {
  const rides = await rideService.listStudentRides({ userId: parent, studentId: s2.id });
  if (!rides.some((r) => r.studentIds.length === 2)) throw new Error('shared ride missing for the second child');
});

console.log('\nMIGRATION');

await check('existing students are grandfathered VERIFIED; admin decisions are kept', async () => {
  const students = mongoose.connection.collection('taxistudents');
  const legacy = new mongoose.Types.ObjectId();
  const rejected = new mongoose.Types.ObjectId();
  await students.insertMany([
    { _id: legacy, userId: parent, name: 'Legacy', dateOfBirth: new Date('2012-01-01'), status: 'ACTIVE', deletedAt: null },
    { _id: rejected, userId: parent, name: 'Rej', dateOfBirth: new Date('2012-01-01'), status: 'ACTIVE', deletedAt: null, verificationStatus: 'REJECTED' },
  ]);
  const rideId = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('taxistudentrides').insertOne({ _id: rideId, userId: parent, studentId: legacy, status: 'COMPLETED' });

  const dry = await migrateStudentVerification({ apply: false });
  if (dry.studentsToVerify !== 1 || dry.ridesToBackfill !== 1) throw new Error(JSON.stringify(dry));
  await migrateStudentVerification({ apply: true });

  const [a, b, ride] = await Promise.all([
    students.findOne({ _id: legacy }), students.findOne({ _id: rejected }),
    mongoose.connection.collection('taxistudentrides').findOne({ _id: rideId }),
  ]);
  if (a.verificationStatus !== 'VERIFIED' || b.verificationStatus !== 'REJECTED') throw new Error(`${a.verificationStatus}/${b.verificationStatus}`);
  if (String(ride.studentIds?.[0]) !== String(legacy)) throw new Error('studentIds not backfilled');

  const again = await migrateStudentVerification({ apply: false });
  if (again.studentsToVerify || again.ridesToBackfill) throw new Error('not idempotent');
});

console.log(`\n${pass} passed, ${fail} failed`);

await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
