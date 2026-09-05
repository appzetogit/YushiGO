export const STUDENT_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
});

export const GUARDIAN_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
});

export const GUARDIAN_RELATIONSHIPS = Object.freeze(['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER']);

export const GUARDIAN_VERIFICATION_STATUS = Object.freeze({
  UNVERIFIED: 'UNVERIFIED',
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
});

export const SAVED_LOCATION_LABELS = Object.freeze(['HOME', 'SCHOOL', 'TUITION', 'COLLEGE', 'OTHER']);

/** A student must be at least this old to be booked without a guardian on file. */
export const GUARDIAN_REQUIRED_BELOW_AGE = 18;

/** Bounds for date-of-birth validation — anything outside is a data-entry error. */
export const STUDENT_MIN_AGE_YEARS = 2;
export const STUDENT_MAX_AGE_YEARS = 100;

/**
 * Stable error codes for the Student Ride module. The HTTP status stays in the
 * throw site; these give clients something to branch on that will not change
 * when the message copy does.
 */
export const STUDENT_RIDE_ERRORS = Object.freeze({
  STUDENT_NOT_FOUND: 'STUDENT_NOT_FOUND',
  STUDENT_NOT_OWNED: 'STUDENT_NOT_OWNED',
  STUDENT_INACTIVE: 'STUDENT_INACTIVE',
  GUARDIAN_REQUIRED: 'GUARDIAN_REQUIRED',
  GUARDIAN_NOT_FOUND: 'GUARDIAN_NOT_FOUND',
  LAST_GUARDIAN_REQUIRED: 'LAST_GUARDIAN_REQUIRED',
  INVALID_DATE_OF_BIRTH: 'INVALID_DATE_OF_BIRTH',
  INVALID_LOCATION: 'INVALID_LOCATION',
  LOCATION_NOT_FOUND: 'LOCATION_NOT_FOUND',
});
