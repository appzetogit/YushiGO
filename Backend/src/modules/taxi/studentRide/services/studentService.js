import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { Student } from '../models/Student.js';
import { StudentGuardian } from '../models/StudentGuardian.js';
import {
  GUARDIAN_REQUIRED_BELOW_AGE,
  GUARDIAN_RELATIONSHIPS,
  GUARDIAN_STATUS,
  STUDENT_MAX_AGE_YEARS,
  STUDENT_MIN_AGE_YEARS,
  STUDENT_RIDE_ERRORS,
  STUDENT_STATUS,
} from '../constants/index.js';

/**
 * Attach a stable machine-readable code to an ApiError without changing the
 * shared error shape the rest of the platform throws.
 */
export const studentRideError = (status, code, message) => {
  const error = new ApiError(status, message);
  error.code = code;
  return error;
};

/**
 * Parse a date-of-birth to UTC midnight.
 *
 * Normalising to UTC matters: a DOB submitted as "2014-08-12" from IST would
 * otherwise land on the 11th once stored, and every age derived from it near a
 * birthday would be off by one.
 */
export const parseDateOfBirth = (value) => {
  const raw = String(value || '').trim();

  if (!raw) {
    throw studentRideError(422, STUDENT_RIDE_ERRORS.INVALID_DATE_OF_BIRTH, 'Date of birth is required.');
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    throw studentRideError(422, STUDENT_RIDE_ERRORS.INVALID_DATE_OF_BIRTH, 'Date of birth is not a valid date.');
  }

  const utcMidnight = new Date(Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate(),
  ));

  if (utcMidnight.getTime() > Date.now()) {
    throw studentRideError(422, STUDENT_RIDE_ERRORS.INVALID_DATE_OF_BIRTH, 'Date of birth cannot be in the future.');
  }

  const age = calculateAge(utcMidnight);

  if (age < STUDENT_MIN_AGE_YEARS || age > STUDENT_MAX_AGE_YEARS) {
    throw studentRideError(
      422,
      STUDENT_RIDE_ERRORS.INVALID_DATE_OF_BIRTH,
      `Date of birth must place the student between ${STUDENT_MIN_AGE_YEARS} and ${STUDENT_MAX_AGE_YEARS} years old.`,
    );
  }

  return utcMidnight;
};

/** Whole years elapsed, counting the birthday itself as the day the age changes. */
export const calculateAge = (dateOfBirth) => {
  const dob = new Date(dateOfBirth);
  const now = new Date();

  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();

  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }

  return age;
};

export const isMinor = (dateOfBirth) => calculateAge(dateOfBirth) < GUARDIAN_REQUIRED_BELOW_AGE;

export const serializeStudent = (student, { guardianCount = undefined } = {}) => ({
  id: String(student._id),
  name: student.name,
  profilePhotoUrl: student.profilePhotoUrl || '',
  dateOfBirth: student.dateOfBirth,
  age: calculateAge(student.dateOfBirth),
  isMinor: isMinor(student.dateOfBirth),
  gender: student.gender || '',
  schoolName: student.schoolName || '',
  className: student.className || '',
  phone: student.phone || '',
  countryCode: student.countryCode || '',
  status: student.status,
  ...(guardianCount === undefined ? {} : { guardianCount }),
  createdAt: student.createdAt,
  updatedAt: student.updatedAt,
});

/**
 * Load a student the caller owns. Every student-scoped operation in this module
 * goes through here — ownership is never inferred from an id in the request body.
 */
export const requireOwnedStudent = async (
  { studentId, userId },
  { session = null, allowInactive = false } = {},
) => {
  if (!mongoose.Types.ObjectId.isValid(String(studentId || ''))) {
    throw studentRideError(404, STUDENT_RIDE_ERRORS.STUDENT_NOT_FOUND, 'Student not found.');
  }

  const query = Student.findOne({ _id: studentId, deletedAt: null });

  if (session) {
    query.session(session);
  }

  const student = await query;

  // A student belonging to someone else is reported as not found rather than
  // forbidden, so the API cannot be used to probe which ids exist.
  if (!student || String(student.userId) !== String(userId)) {
    throw studentRideError(404, STUDENT_RIDE_ERRORS.STUDENT_NOT_FOUND, 'Student not found.');
  }

  if (!allowInactive && student.status !== STUDENT_STATUS.ACTIVE) {
    throw studentRideError(409, STUDENT_RIDE_ERRORS.STUDENT_INACTIVE, 'Student is inactive.');
  }

  return student;
};

export const countActiveGuardians = async (studentId, { session = null } = {}) => {
  const query = StudentGuardian.countDocuments({
    studentId,
    status: GUARDIAN_STATUS.ACTIVE,
    deletedAt: null,
  });

  if (session) {
    query.session(session);
  }

  return query;
};

const normalizeGuardianInput = (guardian = {}) => {
  const name = String(guardian.name || '').trim();
  const mobile = String(guardian.mobile || guardian.phone || '').trim();
  const relationship = String(guardian.relationship || guardian.relation || '').trim().toUpperCase();

  if (!name || !mobile) {
    throw studentRideError(422, STUDENT_RIDE_ERRORS.GUARDIAN_REQUIRED, 'Guardian name and mobile are required.');
  }

  if (!GUARDIAN_RELATIONSHIPS.includes(relationship)) {
    throw studentRideError(
      422,
      STUDENT_RIDE_ERRORS.GUARDIAN_REQUIRED,
      `Guardian relationship must be one of: ${GUARDIAN_RELATIONSHIPS.join(', ')}.`,
    );
  }

  return {
    name,
    mobile,
    relationship,
    countryCode: String(guardian.countryCode || '').trim(),
    email: String(guardian.email || '').trim().toLowerCase(),
    idType: String(guardian.idType || '').trim(),
    idReference: String(guardian.idReference || '').trim(),
    isPrimary: Boolean(guardian.isPrimary),
    isEmergencyContact: guardian.isEmergencyContact === undefined ? true : Boolean(guardian.isEmergencyContact),
  };
};

export const buildGuardianDocuments = (guardians = []) =>
  (Array.isArray(guardians) ? guardians : []).map(normalizeGuardianInput);

export const createStudent = async ({ userId, payload }) => {
  const name = String(payload?.name || '').trim();

  if (!name) {
    throw studentRideError(422, STUDENT_RIDE_ERRORS.INVALID_DATE_OF_BIRTH, 'Student name is required.');
  }

  const dateOfBirth = parseDateOfBirth(payload?.dateOfBirth ?? payload?.date_of_birth);
  const guardians = buildGuardianDocuments(payload?.guardians);

  // The minor rule is enforced here, at the point of record creation, rather
  // than trusted from the client. An age sent by the app is ignored entirely.
  if (isMinor(dateOfBirth) && guardians.length === 0) {
    throw studentRideError(
      422,
      STUDENT_RIDE_ERRORS.GUARDIAN_REQUIRED,
      'Parent/guardian details are required for students below 18 years.',
    );
  }

  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const [student] = await Student.create([{
      userId,
      name,
      dateOfBirth,
      profilePhotoUrl: String(payload?.profilePhotoUrl || '').trim(),
      gender: String(payload?.gender || '').trim().toLowerCase(),
      schoolName: String(payload?.schoolName || payload?.school_name || '').trim(),
      className: String(payload?.className || payload?.class_name || '').trim(),
      phone: String(payload?.phone || '').trim(),
      countryCode: String(payload?.countryCode || '').trim(),
    }], { session });

    if (guardians.length) {
      // Exactly one primary: an explicit choice if the caller made one, else the first.
      const explicitPrimary = guardians.findIndex((guardian) => guardian.isPrimary);
      const primaryIndex = explicitPrimary >= 0 ? explicitPrimary : 0;

      await StudentGuardian.insertMany(
        guardians.map((guardian, index) => ({
          ...guardian,
          isPrimary: index === primaryIndex,
          studentId: student._id,
          userId,
        })),
        { session },
      );
    }

    await session.commitTransaction();

    return serializeStudent(student, { guardianCount: guardians.length });
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

export const listStudents = async ({ userId, includeInactive = false }) => {
  const filter = { userId, deletedAt: null };

  if (!includeInactive) {
    filter.status = STUDENT_STATUS.ACTIVE;
  }

  const students = await Student.find(filter).sort({ createdAt: -1 });

  if (!students.length) {
    return [];
  }

  const counts = await StudentGuardian.aggregate([
    {
      $match: {
        studentId: { $in: students.map((student) => student._id) },
        status: GUARDIAN_STATUS.ACTIVE,
        deletedAt: null,
      },
    },
    { $group: { _id: '$studentId', total: { $sum: 1 } } },
  ]);

  const countByStudent = new Map(counts.map((row) => [String(row._id), row.total]));

  return students.map((student) => serializeStudent(student, {
    guardianCount: countByStudent.get(String(student._id)) || 0,
  }));
};

export const getStudent = async ({ studentId, userId }) => {
  const student = await requireOwnedStudent({ studentId, userId }, { allowInactive: true });

  return serializeStudent(student, {
    guardianCount: await countActiveGuardians(student._id),
  });
};

export const updateStudent = async ({ studentId, userId, payload }) => {
  const student = await requireOwnedStudent({ studentId, userId }, { allowInactive: true });

  if (payload?.name !== undefined) {
    const name = String(payload.name || '').trim();

    if (!name) {
      throw studentRideError(422, STUDENT_RIDE_ERRORS.INVALID_DATE_OF_BIRTH, 'Student name cannot be empty.');
    }

    student.name = name;
  }

  if (payload?.dateOfBirth !== undefined || payload?.date_of_birth !== undefined) {
    const dateOfBirth = parseDateOfBirth(payload.dateOfBirth ?? payload.date_of_birth);

    // Editing the DOB can pull a student below 18. Refuse rather than leave a
    // minor on file with no guardian.
    if (isMinor(dateOfBirth) && (await countActiveGuardians(student._id)) === 0) {
      throw studentRideError(
        422,
        STUDENT_RIDE_ERRORS.GUARDIAN_REQUIRED,
        'Parent/guardian details are required for students below 18 years.',
      );
    }

    student.dateOfBirth = dateOfBirth;
  }

  const directFields = [
    ['profilePhotoUrl', 'profilePhotoUrl'],
    ['gender', 'gender'],
    ['schoolName', 'school_name'],
    ['className', 'class_name'],
    ['phone', 'phone'],
    ['countryCode', 'countryCode'],
  ];

  for (const [field, snakeAlias] of directFields) {
    const value = payload?.[field] ?? payload?.[snakeAlias];

    if (value !== undefined) {
      student[field] = String(value || '').trim();
    }
  }

  await student.save();

  return serializeStudent(student, {
    guardianCount: await countActiveGuardians(student._id),
  });
};

/**
 * Deactivate rather than delete. Completed rides, ride events and emergency
 * records reference this student and must keep resolving.
 */
export const deactivateStudent = async ({ studentId, userId }) => {
  const student = await requireOwnedStudent({ studentId, userId }, { allowInactive: true });

  student.status = STUDENT_STATUS.INACTIVE;
  await student.save();

  return serializeStudent(student);
};

export const reactivateStudent = async ({ studentId, userId }) => {
  const student = await requireOwnedStudent({ studentId, userId }, { allowInactive: true });

  if (isMinor(student.dateOfBirth) && (await countActiveGuardians(student._id)) === 0) {
    throw studentRideError(
      422,
      STUDENT_RIDE_ERRORS.GUARDIAN_REQUIRED,
      'Parent/guardian details are required for students below 18 years.',
    );
  }

  student.status = STUDENT_STATUS.ACTIVE;
  await student.save();

  return serializeStudent(student);
};
