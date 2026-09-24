import { blindIndex, encryptField } from '../../../../utils/fieldCrypto.js';
import { STUDENT_RIDE_ERRORS, STUDENT_VERIFICATION_STATUS } from '../constants/index.js';

/**
 * A student's identity: Aadhaar, school ID, and the admin review of them.
 *
 * Kept apart from studentService so the rules about what an edit does to a
 * verified student live in one place.
 */

// Verhoeff checksum — every real Aadhaar number carries one, so a typo is
// caught here instead of costing a provider call or an admin's time.
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const verhoeffValid = (digits) => {
  let check = 0;
  const reversed = digits.split('').reverse().map(Number);

  for (let i = 0; i < reversed.length; i += 1) {
    check = VERHOEFF_D[check][VERHOEFF_P[i % 8][reversed[i]]];
  }

  return check === 0;
};

const identityError = (status, code, message) => {
  const error = new Error(message);
  error.statusCode = status;
  error.code = code;
  return error;
};

/** 12 digits, not starting 0 or 1, with a valid checksum. Returns the digits or throws. */
export const normalizeAadhaarNumber = (value) => {
  const digits = String(value || '').replace(/[\s-]/g, '');

  if (!/^[2-9]\d{11}$/.test(digits) || !verhoeffValid(digits)) {
    throw identityError(422, STUDENT_RIDE_ERRORS.INVALID_AADHAAR, 'Enter a valid 12-digit Aadhaar number.');
  }

  return digits;
};

/** The fields to store for an Aadhaar number. Only the last four are ever readable. */
export const aadhaarStorage = (digits) => ({
  encrypted: encryptField(digits),
  lookup: blindIndex(`aadhaar:${digits}`),
  last4: digits.slice(-4),
});

export const lookupForAadhaar = (digits) => blindIndex(`aadhaar:${digits}`);

/** What the parent and admin see: never the number, only whether it is on file and checked. */
export const serializeIdentity = (student) => ({
  aadhaar: {
    provided: Boolean(student.aadhaar?.last4),
    last4: student.aadhaar?.last4 || '',
    masked: student.aadhaar?.last4 ? `XXXX XXXX ${student.aadhaar.last4}` : '',
    verified: Boolean(student.aadhaar?.verified),
    verifiedAt: student.aadhaar?.verifiedAt || null,
  },
  studentIdNumber: student.studentIdNumber || '',
  studentIdPhotoUrl: student.studentIdPhotoUrl || '',
  verificationStatus: student.verificationStatus || STUDENT_VERIFICATION_STATUS.PENDING,
  verifiedAt: student.verifiedAt || null,
  rejectionReason: student.rejectionReason || '',
});

/**
 * Apply identity fields from a create or update payload to a student document.
 *
 * Returns true when something that identifies the child changed. A verified or
 * rejected student whose identity changes goes back to PENDING: an approval is
 * of specific details, and a parent must not be able to swap them afterwards.
 */
export const applyIdentityInput = (student, payload = {}) => {
  let changed = false;

  const aadhaarInput = payload.aadhaarNumber ?? payload.aadhaar_number ?? payload.aadharNumber ?? payload.aadhar_number;

  if (aadhaarInput !== undefined && aadhaarInput !== null && String(aadhaarInput).trim() !== '') {
    const digits = normalizeAadhaarNumber(aadhaarInput);
    const lookup = lookupForAadhaar(digits);

    // Re-sending the same number (an edit form posting every field) is not a change.
    if (student.aadhaar?.lookup !== lookup) {
      student.aadhaar = { ...aadhaarStorage(digits), verified: false, verifiedAt: null, provider: '', providerName: '' };
      changed = true;
    }
  }

  for (const [field, aliases] of [
    ['studentIdNumber', ['studentIdNumber', 'student_id_number']],
    ['studentIdPhotoUrl', ['studentIdPhotoUrl', 'student_id_photo_url']],
  ]) {
    const raw = aliases.map((key) => payload[key]).find((value) => value !== undefined);

    if (raw !== undefined) {
      const value = String(raw || '').trim();

      if (field === 'studentIdPhotoUrl' && value && !/^(https?:\/\/|\/uploads\/)/i.test(value)) {
        throw identityError(422, STUDENT_RIDE_ERRORS.INVALID_REVIEW, 'studentIdPhotoUrl must be an uploaded image URL.');
      }

      if ((student[field] || '') !== value) {
        student[field] = value;
        changed = true;
      }
    }
  }

  return changed;
};

/** Send a student back for review after an identity change. */
export const resetReview = (student) => {
  if (student.verificationStatus !== STUDENT_VERIFICATION_STATUS.PENDING) {
    student.verificationStatus = STUDENT_VERIFICATION_STATUS.PENDING;
    student.verifiedBy = null;
    student.verifiedAt = null;
    student.rejectionReason = '';
  }
};

/** The booking gate. Everything but viewing and editing the profile goes through here. */
export const assertStudentVerified = (student) => {
  const status = student?.verificationStatus || STUDENT_VERIFICATION_STATUS.PENDING;

  if (status === STUDENT_VERIFICATION_STATUS.VERIFIED) {
    return;
  }

  throw identityError(
    403,
    STUDENT_RIDE_ERRORS.STUDENT_NOT_VERIFIED,
    status === STUDENT_VERIFICATION_STATUS.REJECTED
      ? `${student?.name || 'This student'} was not approved${student?.rejectionReason ? `: ${student.rejectionReason}` : ''}. Update the details and resubmit.`
      : `${student?.name || 'This student'} is waiting for verification. Rides can be booked once approved.`,
  );
};
