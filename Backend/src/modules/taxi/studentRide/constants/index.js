export const STUDENT_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
});

/**
 * Admin review of a student's identity. Separate from STUDENT_STATUS, which is
 * the parent's own active/inactive switch: a student can be active and still
 * waiting on review.
 */
export const STUDENT_VERIFICATION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
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
  STUDENT_NOT_VERIFIED: 'STUDENT_NOT_VERIFIED',
  INVALID_AADHAAR: 'INVALID_AADHAAR',
  AADHAAR_PROVIDER_NOT_CONFIGURED: 'AADHAAR_PROVIDER_NOT_CONFIGURED',
  AADHAAR_NOT_INITIATED: 'AADHAAR_NOT_INITIATED',
  AADHAAR_VERIFICATION_FAILED: 'AADHAAR_VERIFICATION_FAILED',
  DOB_LOCKED: 'DOB_LOCKED',
  TOO_MANY_STUDENTS: 'TOO_MANY_STUDENTS',
  VEHICLE_NOT_ALLOWED: 'VEHICLE_NOT_ALLOWED',
  INVALID_REVIEW: 'INVALID_REVIEW',
});

/**
 * Student ride lifecycle (§16).
 *
 * Deliberately separate from RIDE_STATUS/RIDE_LIVE_STATUS on the underlying
 * TaxiRide: those describe dispatch, this describes the safety workflow. A ride
 * can be ONGOING to the dispatcher while still waiting on a pickup OTP here.
 */
export const STUDENT_RIDE_STATUS = Object.freeze({
  BOOKED: 'BOOKED',
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DRIVER_ARRIVING: 'DRIVER_ARRIVING',
  DRIVER_ARRIVED: 'DRIVER_ARRIVED',
  PICKUP_OTP_VERIFIED: 'PICKUP_OTP_VERIFIED',
  RIDE_STARTED: 'RIDE_STARTED',
  NEAR_DESTINATION: 'NEAR_DESTINATION',
  DROP_OTP_VERIFIED: 'DROP_OTP_VERIFIED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
  FAILED: 'FAILED',
});

/**
 * The only transitions the machine accepts (§16). Anything absent is refused,
 * so BOOKED cannot jump to COMPLETED and a verified pickup cannot be replayed.
 */
export const STUDENT_RIDE_TRANSITIONS = Object.freeze({
  BOOKED: ['DRIVER_ASSIGNED', 'CANCELLED', 'FAILED'],
  DRIVER_ASSIGNED: ['DRIVER_ARRIVING', 'CANCELLED', 'FAILED'],
  DRIVER_ARRIVING: ['DRIVER_ARRIVED', 'CANCELLED', 'FAILED'],
  DRIVER_ARRIVED: ['PICKUP_OTP_VERIFIED', 'CANCELLED', 'NO_SHOW', 'FAILED'],
  PICKUP_OTP_VERIFIED: ['RIDE_STARTED', 'CANCELLED', 'FAILED'],
  RIDE_STARTED: ['NEAR_DESTINATION', 'DROP_OTP_VERIFIED', 'CANCELLED', 'FAILED'],
  NEAR_DESTINATION: ['DROP_OTP_VERIFIED', 'CANCELLED', 'FAILED'],
  DROP_OTP_VERIFIED: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
  FAILED: [],
});

/** Statuses after which a ride can no longer be cancelled by the rider. */
export const STUDENT_RIDE_CANCELLABLE = Object.freeze([
  'BOOKED', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED',
]);

export const STUDENT_RIDE_EVENTS = Object.freeze({
  RIDE_BOOKED: 'RIDE_BOOKED',
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DRIVER_ARRIVING: 'DRIVER_ARRIVING',
  DRIVER_ARRIVED: 'DRIVER_ARRIVED',
  PICKUP_OTP_VERIFIED: 'PICKUP_OTP_VERIFIED',
  PICKUP_OTP_FAILED: 'PICKUP_OTP_FAILED',
  PICKUP_OTP_ISSUED: 'PICKUP_OTP_ISSUED',
  PICKUP_OTP_BYPASSED: 'PICKUP_OTP_BYPASSED',
  RIDE_STARTED: 'RIDE_STARTED',
  ROUTE_DEVIATION: 'ROUTE_DEVIATION',
  NEAR_DESTINATION: 'NEAR_DESTINATION',
  DROP_OTP_ISSUED: 'DROP_OTP_ISSUED',
  DROP_OTP_BYPASSED: 'DROP_OTP_BYPASSED',
  DROP_OTP_VERIFIED: 'DROP_OTP_VERIFIED',
  DROP_OTP_FAILED: 'DROP_OTP_FAILED',
  RIDE_COMPLETED: 'RIDE_COMPLETED',
  RIDE_CANCELLED: 'RIDE_CANCELLED',
  SOS_TRIGGERED: 'SOS_TRIGGERED',
});

const numberFromEnv = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const studentRideConfig = () => ({
  otpLength: 4,
  otpExpirySeconds: numberFromEnv('STUDENT_RIDE_OTP_EXPIRY_SECONDS', 30 * 60),
  /**
   * How long a pickup code stays usable, counted from when the ride is due rather
   * than from booking.
   *
   * The drop code lives thirty minutes because it is minted as the journey
   * starts. The pickup code is minted at booking, so a thirty-minute life killed
   * it long before a scheduled ride's driver arrived, and even an immediate ride
   * waiting half an hour for a match reached the gate with a dead code. The code
   * is only useful with the child physically present, which is what bounds the
   * risk of a longer window.
   */
  pickupOtpExpirySeconds: numberFromEnv('STUDENT_RIDE_PICKUP_OTP_EXPIRY_SECONDS', 3 * 60 * 60),
  otpMaxAttempts: numberFromEnv('STUDENT_RIDE_OTP_MAX_ATTEMPTS', 5),
  shareTokenExpiryHours: numberFromEnv('STUDENT_RIDE_SHARE_TTL_HOURS', 12),
  // Hard ceiling on siblings in one booking; the admin setting may lower it.
  maxChildrenPerRide: numberFromEnv('STUDENT_RIDE_MAX_CHILDREN', 4),
});

export const STUDENT_RIDE_ERROR_CODES = Object.freeze({
  RIDE_NOT_FOUND: 'RIDE_NOT_FOUND',
  RIDE_NOT_OWNED: 'RIDE_NOT_OWNED',
  INVALID_RIDE_STATUS: 'INVALID_RIDE_STATUS',
  INVALID_OTP: 'INVALID_OTP',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_ATTEMPTS_EXCEEDED: 'OTP_ATTEMPTS_EXCEEDED',
  OTP_ALREADY_VERIFIED: 'OTP_ALREADY_VERIFIED',
  UNAUTHORIZED_DRIVER: 'UNAUTHORIZED_DRIVER',
  CANCELLATION_NOT_ALLOWED: 'CANCELLATION_NOT_ALLOWED',
});
