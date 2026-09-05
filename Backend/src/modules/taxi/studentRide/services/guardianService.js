import mongoose from 'mongoose';
import { StudentGuardian } from '../models/StudentGuardian.js';
import {
  GUARDIAN_RELATIONSHIPS,
  GUARDIAN_STATUS,
  STUDENT_RIDE_ERRORS,
} from '../constants/index.js';
import {
  buildGuardianDocuments,
  countActiveGuardians,
  isMinor,
  requireOwnedStudent,
  studentRideError,
} from './studentService.js';

/**
 * Identification fields are `select: false` on the schema and are never included
 * here. Nothing in the module returns them, and public tracking never sees a
 * guardian at all.
 */
export const serializeGuardian = (guardian) => ({
  id: String(guardian._id),
  studentId: String(guardian.studentId),
  name: guardian.name,
  relationship: guardian.relationship,
  mobile: guardian.mobile,
  countryCode: guardian.countryCode || '',
  email: guardian.email || '',
  isPrimary: Boolean(guardian.isPrimary),
  isEmergencyContact: Boolean(guardian.isEmergencyContact),
  verificationStatus: guardian.verificationStatus,
  status: guardian.status,
  createdAt: guardian.createdAt,
  updatedAt: guardian.updatedAt,
});

const requireOwnedGuardian = async ({ guardianId, userId }, { session = null } = {}) => {
  if (!mongoose.Types.ObjectId.isValid(String(guardianId || ''))) {
    throw studentRideError(404, STUDENT_RIDE_ERRORS.GUARDIAN_NOT_FOUND, 'Guardian not found.');
  }

  const query = StudentGuardian.findOne({ _id: guardianId, deletedAt: null });

  if (session) {
    query.session(session);
  }

  const guardian = await query;

  if (!guardian || String(guardian.userId) !== String(userId)) {
    throw studentRideError(404, STUDENT_RIDE_ERRORS.GUARDIAN_NOT_FOUND, 'Guardian not found.');
  }

  return guardian;
};

export const listGuardians = async ({ studentId, userId }) => {
  await requireOwnedStudent({ studentId, userId }, { allowInactive: true });

  const guardians = await StudentGuardian.find({ studentId, deletedAt: null })
    .sort({ isPrimary: -1, createdAt: 1 });

  return guardians.map(serializeGuardian);
};

export const addGuardian = async ({ studentId, userId, payload }) => {
  const student = await requireOwnedStudent({ studentId, userId }, { allowInactive: true });
  const [guardianInput] = buildGuardianDocuments([payload]);

  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const existingCount = await countActiveGuardians(student._id, { session });
    // First guardian on file is primary regardless of what the client sent.
    const shouldBePrimary = existingCount === 0 ? true : guardianInput.isPrimary;

    if (shouldBePrimary) {
      await StudentGuardian.updateMany(
        { studentId: student._id, deletedAt: null },
        { isPrimary: false },
        { session },
      );
    }

    const [guardian] = await StudentGuardian.create([{
      ...guardianInput,
      isPrimary: shouldBePrimary,
      studentId: student._id,
      userId,
    }], { session });

    await session.commitTransaction();

    return serializeGuardian(guardian);
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

export const updateGuardian = async ({ guardianId, userId, payload }) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const guardian = await requireOwnedGuardian({ guardianId, userId }, { session });

    if (payload?.name !== undefined) {
      const name = String(payload.name || '').trim();

      if (!name) {
        throw studentRideError(422, STUDENT_RIDE_ERRORS.GUARDIAN_REQUIRED, 'Guardian name cannot be empty.');
      }

      guardian.name = name;
    }

    if (payload?.mobile !== undefined || payload?.phone !== undefined) {
      const mobile = String(payload.mobile ?? payload.phone ?? '').trim();

      if (!mobile) {
        throw studentRideError(422, STUDENT_RIDE_ERRORS.GUARDIAN_REQUIRED, 'Guardian mobile cannot be empty.');
      }

      guardian.mobile = mobile;
    }

    if (payload?.relationship !== undefined) {
      const relationship = String(payload.relationship || '').trim().toUpperCase();

      if (!GUARDIAN_RELATIONSHIPS.includes(relationship)) {
        throw studentRideError(
          422,
          STUDENT_RIDE_ERRORS.GUARDIAN_REQUIRED,
          `Guardian relationship must be one of: ${GUARDIAN_RELATIONSHIPS.join(', ')}.`,
        );
      }

      guardian.relationship = relationship;
    }

    for (const field of ['countryCode', 'email', 'idType', 'idReference']) {
      if (payload?.[field] !== undefined) {
        guardian[field] = String(payload[field] || '').trim();
      }
    }

    if (payload?.isEmergencyContact !== undefined) {
      guardian.isEmergencyContact = Boolean(payload.isEmergencyContact);
    }

    if (payload?.isPrimary === true && !guardian.isPrimary) {
      await StudentGuardian.updateMany(
        { studentId: guardian.studentId, deletedAt: null, _id: { $ne: guardian._id } },
        { isPrimary: false },
        { session },
      );

      guardian.isPrimary = true;
    }

    await guardian.save({ session });
    await session.commitTransaction();

    return serializeGuardian(guardian);
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Removing a guardian can strand a minor with none on file, which is exactly the
 * state the registration rule exists to prevent. Refuse the last one.
 */
export const removeGuardian = async ({ guardianId, userId }) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const guardian = await requireOwnedGuardian({ guardianId, userId }, { session });
    const student = await requireOwnedStudent(
      { studentId: guardian.studentId, userId },
      { session, allowInactive: true },
    );

    const activeCount = await countActiveGuardians(student._id, { session });

    if (isMinor(student.dateOfBirth) && activeCount <= 1) {
      throw studentRideError(
        422,
        STUDENT_RIDE_ERRORS.LAST_GUARDIAN_REQUIRED,
        'A student below 18 years must have at least one guardian.',
      );
    }

    guardian.status = GUARDIAN_STATUS.INACTIVE;
    guardian.deletedAt = new Date();
    guardian.isPrimary = false;
    await guardian.save({ session });

    // Never leave a student without a primary while other guardians remain.
    const replacement = await StudentGuardian.findOne({
      studentId: student._id,
      status: GUARDIAN_STATUS.ACTIVE,
      deletedAt: null,
    }).sort({ createdAt: 1 }).session(session);

    if (replacement && !replacement.isPrimary) {
      replacement.isPrimary = true;
      await replacement.save({ session });
    }

    await session.commitTransaction();

    return { id: String(guardian._id), removed: true };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

/** Emergency contacts for a student — used by the SOS flow in a later phase. */
export const listEmergencyContacts = async (studentId) => {
  const guardians = await StudentGuardian.find({
    studentId,
    status: GUARDIAN_STATUS.ACTIVE,
    isEmergencyContact: true,
    deletedAt: null,
  }).sort({ isPrimary: -1, createdAt: 1 });

  return guardians.map(serializeGuardian);
};
