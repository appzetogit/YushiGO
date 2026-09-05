/**
 * Student Ride — Gate 1 acceptance suite (students, guardians, saved locations).
 *
 *   node tests/studentRide/gate1.mjs
 *
 * Creates a uniquely named scratch database, exercises the service layer
 * directly, and drops the database afterwards. Nothing here touches
 * application data.
 */
import mongoose from 'mongoose';

// Runs against a throwaway database, never the application one. Transactions
// are required, so the URI must point at the replica set.
const DB_NAME = `student_ride_test_${Date.now()}`;
process.env.MONGODB_URI = process.env.STUDENT_RIDE_TEST_URI
  || `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';

const svc = await import('../../src/modules/taxi/studentRide/services/studentService.js');
const guardianSvc = await import('../../src/modules/taxi/studentRide/services/guardianService.js');
const locSvc = await import('../../src/modules/taxi/studentRide/services/savedLocationService.js');

// autoIndex off: background index builds hold collection locks that make the
// first transaction time out on a freshly created collection.
await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

// Collections must exist before any transaction touches them: creating one
// inside a transaction raises a catalog WriteConflict. Each run uses a fresh
// database name, so there is nothing to drop first.
for (const name of ['TaxiStudent', 'TaxiStudentGuardian', 'TaxiStudentSavedLocation']) {
  await mongoose.model(name).createCollection();
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
      if (error.code !== code) {
        throw new Error(`expected code ${code}, got ${error.code} (${error.message})`);
      }
      return;
    }
    throw new Error('expected rejection, call succeeded');
  });
};

const userA = new mongoose.Types.ObjectId();
const userB = new mongoose.Types.ObjectId();

console.log('\nAGE + MINOR RULE');

await check('age derived from DOB, not trusted from client', async () => {
  const dob = new Date();
  dob.setUTCFullYear(dob.getUTCFullYear() - 12);
  const age = svc.calculateAge(dob);
  if (age !== 12) throw new Error(`expected 12, got ${age}`);
});

await check('birthday boundary: day before 18th still a minor', async () => {
  const dob = new Date();
  dob.setUTCFullYear(dob.getUTCFullYear() - 18);
  dob.setUTCDate(dob.getUTCDate() + 1);
  if (!svc.isMinor(dob)) throw new Error('should still be a minor');
});

await expectReject('minor without guardian rejected', 'GUARDIAN_REQUIRED', () =>
  svc.createStudent({ userId: userA, payload: { name: 'Aarohi', dateOfBirth: '2014-08-12' } }));

await expectReject('future DOB rejected', 'INVALID_DATE_OF_BIRTH', () =>
  svc.createStudent({ userId: userA, payload: { name: 'X', dateOfBirth: '2099-01-01' } }));

await expectReject('nonsense DOB rejected', 'INVALID_DATE_OF_BIRTH', () =>
  svc.createStudent({ userId: userA, payload: { name: 'X', dateOfBirth: 'not-a-date' } }));

await check('client-sent age is ignored', async () => {
  const student = await svc.createStudent({
    userId: userA,
    payload: { name: 'Liar', dateOfBirth: '2014-08-12', age: 45, guardians: [
      { name: 'P', mobile: '9990001111', relationship: 'FATHER' },
    ] },
  });
  if (student.age === 45) throw new Error('client age was trusted');
  if (!student.isMinor) throw new Error('should be a minor');
});

console.log('\nMULTI-STUDENT ISOLATION');

const aarohi = await svc.createStudent({
  userId: userA,
  payload: {
    name: 'Aarohi Sharma', dateOfBirth: '2014-08-12', gender: 'female',
    schoolName: "St. Teresa's", className: '8-A',
    guardians: [{ name: 'Varun Sharma', mobile: '9876543210', relationship: 'FATHER' }],
  },
});
const rahul = await svc.createStudent({
  userId: userA,
  payload: { name: 'Rahul', dateOfBirth: '2012-03-01',
    guardians: [{ name: 'Varun Sharma', mobile: '9876543210', relationship: 'FATHER' }] },
});
const ananya = await svc.createStudent({
  userId: userB,
  payload: { name: 'Ananya', dateOfBirth: '2005-05-05' },
});

await check('adult student needs no guardian', async () => {
  if (ananya.isMinor) throw new Error('should be adult');
});

await check('one user holds many students', async () => {
  const list = await svc.listStudents({ userId: userA });
  if (list.length !== 3) throw new Error(`expected 3, got ${list.length}`);
});

await expectReject("user A cannot read user B's student", 'STUDENT_NOT_FOUND', () =>
  svc.getStudent({ studentId: ananya.id, userId: userA }));

await expectReject('garbage id is not found, not a 500', 'STUDENT_NOT_FOUND', () =>
  svc.getStudent({ studentId: 'not-an-objectid', userId: userA }));

console.log('\nGUARDIANS');

await check('guardian added, first is primary', async () => {
  const guardians = await guardianSvc.listGuardians({ studentId: aarohi.id, userId: userA });
  if (guardians.length !== 1) throw new Error(`expected 1, got ${guardians.length}`);
  if (!guardians[0].isPrimary) throw new Error('first guardian should be primary');
});

const mother = await guardianSvc.addGuardian({
  studentId: aarohi.id, userId: userA,
  payload: { name: 'Meera Sharma', mobile: '9876500000', relationship: 'MOTHER', isPrimary: true },
});

await check('new primary demotes the old one', async () => {
  const guardians = await guardianSvc.listGuardians({ studentId: aarohi.id, userId: userA });
  const primaries = guardians.filter((g) => g.isPrimary);
  if (primaries.length !== 1) throw new Error(`expected exactly 1 primary, got ${primaries.length}`);
  if (primaries[0].id !== mother.id) throw new Error('wrong primary');
});

await check('guardian response never carries ID document fields', async () => {
  const guardians = await guardianSvc.listGuardians({ studentId: aarohi.id, userId: userA });
  for (const g of guardians) {
    if ('idType' in g || 'idReference' in g) throw new Error('ID fields leaked');
  }
});

await expectReject("user B cannot touch user A's guardian", 'GUARDIAN_NOT_FOUND', () =>
  guardianSvc.updateGuardian({ guardianId: mother.id, userId: userB, payload: { name: 'hack' } }));

await check('can remove a guardian while another remains', async () => {
  await guardianSvc.removeGuardian({ guardianId: mother.id, userId: userA });
});

await expectReject('cannot remove the last guardian of a minor', 'LAST_GUARDIAN_REQUIRED', async () => {
  const [last] = await guardianSvc.listGuardians({ studentId: aarohi.id, userId: userA });
  return guardianSvc.removeGuardian({ guardianId: last.id, userId: userA });
});

console.log('\nSAVED LOCATIONS');

const home = await locSvc.createSavedLocation({
  studentId: aarohi.id, userId: userA,
  payload: { label: 'HOME', address: 'Sector 36, Noida', latitude: 28.46, longitude: 77.51 },
});
await locSvc.createSavedLocation({
  studentId: aarohi.id, userId: userA,
  payload: { label: 'SCHOOL', customName: "St. Teresa's", address: 'Knowledge Park II', latitude: 28.47, longitude: 77.52 },
});
const rahulHome = await locSvc.createSavedLocation({
  studentId: rahul.id, userId: userA,
  payload: { label: 'HOME', address: 'Sector 36, Noida', latitude: 28.46, longitude: 77.51 },
});

await check("locations do not bleed between one user's students", async () => {
  const aarohiLocs = await locSvc.listSavedLocations({ studentId: aarohi.id, userId: userA });
  const rahulLocs = await locSvc.listSavedLocations({ studentId: rahul.id, userId: userA });
  if (aarohiLocs.length !== 2) throw new Error(`Aarohi expected 2, got ${aarohiLocs.length}`);
  if (rahulLocs.length !== 1) throw new Error(`Rahul expected 1, got ${rahulLocs.length}`);
  if (rahulLocs.some((l) => l.id === home.id)) throw new Error('cross-student leak');
});

await expectReject('location rejected for a student it does not belong to', 'LOCATION_NOT_FOUND', () =>
  locSvc.requireOwnedSavedLocation({ locationId: rahulHome.id, studentId: aarohi.id, userId: userA }));

await expectReject('latitude out of range rejected', 'INVALID_LOCATION', () =>
  locSvc.createSavedLocation({ studentId: aarohi.id, userId: userA,
    payload: { label: 'OTHER', address: 'x', latitude: 999, longitude: 77 } }));

await expectReject('longitude out of range rejected', 'INVALID_LOCATION', () =>
  locSvc.createSavedLocation({ studentId: aarohi.id, userId: userA,
    payload: { label: 'OTHER', address: 'x', latitude: 28, longitude: 999 } }));

await expectReject('unknown label rejected', 'INVALID_LOCATION', () =>
  locSvc.createSavedLocation({ studentId: aarohi.id, userId: userA,
    payload: { label: 'SPACESHIP', address: 'x', latitude: 28, longitude: 77 } }));

await expectReject('lat without lng rejected', 'INVALID_LOCATION', () =>
  locSvc.updateSavedLocation({ locationId: home.id, userId: userA, payload: { latitude: 29 } }));

await expectReject("user B cannot read user A's location", 'LOCATION_NOT_FOUND', () =>
  locSvc.getSavedLocation({ locationId: home.id, userId: userB }));

console.log('\nDEACTIVATION');

await check('deactivated student disappears from the default list but still resolves', async () => {
  await svc.deactivateStudent({ studentId: rahul.id, userId: userA });
  const active = await svc.listStudents({ userId: userA });
  if (active.some((s) => s.id === rahul.id)) throw new Error('inactive student still listed');
  const fetched = await svc.getStudent({ studentId: rahul.id, userId: userA });
  if (fetched.status !== 'INACTIVE') throw new Error('status not INACTIVE');
});

await check('reactivation restores the student', async () => {
  await svc.reactivateStudent({ studentId: rahul.id, userId: userA });
  const active = await svc.listStudents({ userId: userA });
  if (!active.some((s) => s.id === rahul.id)) throw new Error('not restored');
});

console.log(`\n${pass} passed, ${fail} failed`);

await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
