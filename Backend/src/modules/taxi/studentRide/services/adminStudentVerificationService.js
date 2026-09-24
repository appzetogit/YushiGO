import mongoose from 'mongoose';
import { Student } from '../models/Student.js';
import { StudentGuardian } from '../models/StudentGuardian.js';
import { GUARDIAN_STATUS, STUDENT_RIDE_ERRORS, STUDENT_VERIFICATION_STATUS } from '../constants/index.js';
import { calculateAge, isMinor, studentRideError } from './studentService.js';
import { serializeIdentity } from './studentIdentityService.js';

/**
 * Admin review of students (approve / reject).
 *
 * The admin sees the last four Aadhaar digits, whether the number was verified
 * through the provider (and the name the provider returned), the school ID and
 * its photo — never the full Aadhaar number.
 */

const pageParams = (query = {}) => {
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const page = Math.max(1, Number(query.page) || 1);
  return { limit, page, skip: (page - 1) * limit };
};

const serializeForAdmin = (student, { parent = null, guardianCount = 0, duplicates = 0 } = {}) => ({
  id: String(student._id),
  name: student.name,
  profilePhotoUrl: student.profilePhotoUrl || '',
  dateOfBirth: student.dateOfBirth,
  age: calculateAge(student.dateOfBirth),
  ageCategory: isMinor(student.dateOfBirth) ? 'child' : 'adult',
  gender: student.gender || '',
  schoolName: student.schoolName || '',
  className: student.className || '',
  status: student.status,
  ...serializeIdentity(student),
  aadhaarProviderName: student.aadhaar?.providerName || '',
  // Same Aadhaar on other student records — usually both parents registering
  // one child, occasionally something to look at.
  aadhaarDuplicates: duplicates,
  guardianCount,
  parent: parent
    ? { id: String(parent._id), name: parent.name || '', phone: parent.phone || '', email: parent.email || '' }
    : { id: String(student.userId) },
  createdAt: student.createdAt,
  updatedAt: student.updatedAt,
});

const enrich = async (students) => {
  if (!students.length) {
    return [];
  }

  const { User } = await import('../../user/models/User.js');
  const [parents, guardianCounts, duplicateCounts] = await Promise.all([
    User.find({ _id: { $in: students.map((s) => s.userId) } }).select('name phone email').lean(),
    StudentGuardian.aggregate([
      { $match: { studentId: { $in: students.map((s) => s._id) }, status: GUARDIAN_STATUS.ACTIVE, deletedAt: null } },
      { $group: { _id: '$studentId', total: { $sum: 1 } } },
    ]),
    Student.aggregate([
      { $match: { 'aadhaar.lookup': { $in: students.map((s) => s.aadhaar?.lookup).filter(Boolean) }, deletedAt: null } },
      { $group: { _id: '$aadhaar.lookup', total: { $sum: 1 } } },
    ]),
  ]);

  const parentById = new Map(parents.map((p) => [String(p._id), p]));
  const guardiansById = new Map(guardianCounts.map((row) => [String(row._id), row.total]));
  const dupByLookup = new Map(duplicateCounts.map((row) => [row._id, row.total]));

  return students.map((student) => serializeForAdmin(student, {
    parent: parentById.get(String(student.userId)) || null,
    guardianCount: guardiansById.get(String(student._id)) || 0,
    duplicates: Math.max(0, (dupByLookup.get(student.aadhaar?.lookup) || 1) - 1),
  }));
};

export const listStudentsForAdmin = async (query = {}) => {
  const filter = { deletedAt: null };
  const status = String(query.status || '').toUpperCase();

  if (status) {
    if (!Object.values(STUDENT_VERIFICATION_STATUS).includes(status)) {
      throw studentRideError(422, STUDENT_RIDE_ERRORS.INVALID_REVIEW, `Unknown status ${status}.`);
    }
    filter.verificationStatus = status;
  }

  if (query.search) {
    const text = String(query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ name: { $regex: text, $options: 'i' } }, { studentIdNumber: { $regex: text, $options: 'i' } }];
  }

  const { limit, page, skip } = pageParams(query);
  const [students, total, counts] = await Promise.all([
    Student.find(filter).select('+aadhaar.lookup').sort({ createdAt: status === 'PENDING' ? 1 : -1 }).skip(skip).limit(limit),
    Student.countDocuments(filter),
    Student.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: '$verificationStatus', total: { $sum: 1 } } }]),
  ]);

  return {
    results: await enrich(students),
    counts: Object.fromEntries(Object.values(STUDENT_VERIFICATION_STATUS).map((key) => [
      key,
      counts.find((row) => row._id === key)?.total || 0,
    ])),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
};

const loadForReview = async (studentId) => {
  if (!mongoose.Types.ObjectId.isValid(String(studentId || ''))) {
    throw studentRideError(404, STUDENT_RIDE_ERRORS.STUDENT_NOT_FOUND, 'Student not found.');
  }

  const student = await Student.findOne({ _id: studentId, deletedAt: null }).select('+aadhaar.lookup');

  if (!student) {
    throw studentRideError(404, STUDENT_RIDE_ERRORS.STUDENT_NOT_FOUND, 'Student not found.');
  }

  return student;
};

export const getStudentForAdmin = async (studentId) => {
  const [result] = await enrich([await loadForReview(studentId)]);
  return result;
};

const notifyParentOfReview = async (student) => {
  try {
    const { notifyParent } = await import('./studentRideNotifications.js');
    const approved = student.verificationStatus === STUDENT_VERIFICATION_STATUS.VERIFIED;

    await notifyParent({
      userId: student.userId,
      title: approved ? `${student.name} is verified` : `${student.name} could not be verified`,
      body: approved
        ? 'You can now book student rides.'
        : student.rejectionReason || 'Please check the details and resubmit.',
      data: {
        type: approved ? 'student_verified' : 'student_rejected',
        studentId: String(student._id),
        verificationStatus: student.verificationStatus,
      },
    });
  } catch (error) {
    console.error('[student-ride] review notification failed', error?.message || error);
  }
};

export const approveStudent = async ({ studentId, adminId }) => {
  const student = await loadForReview(studentId);

  student.verificationStatus = STUDENT_VERIFICATION_STATUS.VERIFIED;
  student.verifiedBy = mongoose.Types.ObjectId.isValid(String(adminId || '')) ? adminId : null;
  student.verifiedAt = new Date();
  student.rejectionReason = '';
  await student.save();

  await notifyParentOfReview(student);
  return getStudentForAdmin(student._id);
};

export const rejectStudent = async ({ studentId, adminId, reason }) => {
  const text = String(reason || '').trim();

  if (!text) {
    throw studentRideError(422, STUDENT_RIDE_ERRORS.INVALID_REVIEW, 'A reason is required to reject a student.');
  }

  const student = await loadForReview(studentId);

  student.verificationStatus = STUDENT_VERIFICATION_STATUS.REJECTED;
  student.verifiedBy = mongoose.Types.ObjectId.isValid(String(adminId || '')) ? adminId : null;
  student.verifiedAt = new Date();
  student.rejectionReason = text.slice(0, 500);
  await student.save();

  await notifyParentOfReview(student);
  return getStudentForAdmin(student._id);
};
