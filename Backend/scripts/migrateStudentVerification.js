/**
 * Student verification and multi-child rides — backfill for existing records.
 *
 *   node scripts/migrateStudentVerification.js            # dry run
 *   node scripts/migrateStudentVerification.js --apply    # writes it
 *
 * - Students created before verification existed are grandfathered as VERIFIED,
 *   so parents who already book keep booking. Only students without a
 *   verificationStatus are touched; an admin decision is never overwritten.
 * - Student rides get studentIds = [studentId].
 *
 * Run it BEFORE restarting the API on the new code: until it runs, an existing
 * student reads as PENDING (the schema default) and cannot book.
 */
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

export const migrateStudentVerification = async ({ apply = false, now = new Date() } = {}) => {
  const students = mongoose.connection.collection('taxistudents');
  const rides = mongoose.connection.collection('taxistudentrides');

  const studentFilter = { verificationStatus: { $exists: false } };
  const rideFilter = { studentId: { $exists: true }, studentIds: { $exists: false } };

  const summary = {
    studentsToVerify: await students.countDocuments(studentFilter),
    ridesToBackfill: await rides.countDocuments(rideFilter),
  };

  if (apply) {
    await students.updateMany(studentFilter, {
      $set: { verificationStatus: 'VERIFIED', verifiedAt: now, verifiedBy: null, rejectionReason: '' },
    });
    await rides.updateMany(rideFilter, [{ $set: { studentIds: ['$studentId'] } }]);
  }

  return summary;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  dotenv.config();
  const apply = process.argv.includes('--apply');

  try {
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
    const summary = await migrateStudentVerification({ apply });
    console.log(`${apply ? 'APPLIED' : 'DRY RUN'}`, JSON.stringify(summary));
    if (!apply) console.log('Re-run with --apply to write.');
  } finally {
    await mongoose.disconnect();
  }
}
