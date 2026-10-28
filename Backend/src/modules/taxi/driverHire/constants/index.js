/**
 * Search a Driver (Type A): a verified driver drives the customer's own car.
 * The customer supplies the vehicle; nothing here dispatches a car.
 */

export const DRIVER_HIRE_SERVICE_TYPES = Object.freeze({
  NOW: 'NOW',
  SCHEDULED: 'SCHEDULED',
  HOURLY: 'HOURLY',
  OUTSTATION: 'OUTSTATION',
  EVENT: 'EVENT',
});

export const DRIVER_HIRE_TRANSMISSIONS = Object.freeze({
  MANUAL: 'MANUAL',
  AUTOMATIC: 'AUTOMATIC',
});

export const DRIVER_HIRE_OUTSTATION_TRIP = Object.freeze({
  ONE_WAY: 'ONE_WAY',
  ROUND_TRIP: 'ROUND_TRIP',
});

/**
 * Booking status (spec §2). A quote is the "Draft": it lives in its own
 * collection, so a booking document starts at REQUESTED.
 */
export const DRIVER_HIRE_STATUS = Object.freeze({
  REQUESTED: 'REQUESTED',
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DRIVER_EN_ROUTE: 'DRIVER_EN_ROUTE',
  DRIVER_ARRIVED: 'DRIVER_ARRIVED',
  TRIP_STARTED: 'TRIP_STARTED',
  TRIP_COMPLETED: 'TRIP_COMPLETED',
  CANCELLED_BY_CUSTOMER: 'CANCELLED_BY_CUSTOMER',
  CANCELLED_BY_DRIVER: 'CANCELLED_BY_DRIVER',
  CANCELLED_BY_ADMIN: 'CANCELLED_BY_ADMIN',
  EXPIRED: 'EXPIRED',
  DISPUTED: 'DISPUTED',
});

const S = DRIVER_HIRE_STATUS;

/**
 * Every transition the server allows. Anything not listed here is refused,
 * whoever asks — the state machine is the contract, not the endpoints.
 */
export const DRIVER_HIRE_TRANSITIONS = Object.freeze({
  [S.REQUESTED]: [S.DRIVER_ASSIGNED, S.CANCELLED_BY_CUSTOMER, S.CANCELLED_BY_ADMIN, S.EXPIRED],
  [S.DRIVER_ASSIGNED]: [S.DRIVER_EN_ROUTE, S.REQUESTED, S.CANCELLED_BY_CUSTOMER, S.CANCELLED_BY_DRIVER, S.CANCELLED_BY_ADMIN],
  [S.DRIVER_EN_ROUTE]: [S.DRIVER_ARRIVED, S.REQUESTED, S.CANCELLED_BY_CUSTOMER, S.CANCELLED_BY_DRIVER, S.CANCELLED_BY_ADMIN],
  [S.DRIVER_ARRIVED]: [S.TRIP_STARTED, S.REQUESTED, S.CANCELLED_BY_CUSTOMER, S.CANCELLED_BY_DRIVER, S.CANCELLED_BY_ADMIN],
  [S.TRIP_STARTED]: [S.TRIP_COMPLETED, S.CANCELLED_BY_ADMIN],
  [S.TRIP_COMPLETED]: [S.DISPUTED],
  [S.DISPUTED]: [S.TRIP_COMPLETED],
  [S.CANCELLED_BY_CUSTOMER]: [],
  [S.CANCELLED_BY_DRIVER]: [],
  [S.CANCELLED_BY_ADMIN]: [],
  [S.EXPIRED]: [],
});

/** A driver holding one of these is busy for the booking's window. */
export const DRIVER_HIRE_ACTIVE_STATUSES = Object.freeze([
  S.DRIVER_ASSIGNED,
  S.DRIVER_EN_ROUTE,
  S.DRIVER_ARRIVED,
  S.TRIP_STARTED,
]);

export const DRIVER_HIRE_TERMINAL_STATUSES = Object.freeze([
  S.TRIP_COMPLETED,
  S.CANCELLED_BY_CUSTOMER,
  S.CANCELLED_BY_DRIVER,
  S.CANCELLED_BY_ADMIN,
  S.EXPIRED,
]);

export const DRIVER_HIRE_PROFILE_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SUSPENDED: 'SUSPENDED',
});

export const DRIVER_HIRE_PAYMENT_METHODS = Object.freeze({
  CASH: 'CASH',
  ONLINE: 'ONLINE',
});

export const DRIVER_HIRE_PAYMENT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  NOT_REQUIRED: 'NOT_REQUIRED',
});

export const DRIVER_HIRE_REFUND_STATUS = Object.freeze({
  NONE: 'NONE',
  PENDING: 'PENDING',
  REFUNDED: 'REFUNDED',
});

export const DRIVER_HIRE_PAYMENT_KIND = Object.freeze({
  TRIP: 'TRIP',
  CANCELLATION_FEE: 'CANCELLATION_FEE',
});

export const DRIVER_HIRE_SUPPORT_CATEGORIES = Object.freeze([
  'SAFETY',
  'ACCIDENT',
  'VEHICLE_CONDITION',
  'HARASSMENT',
  'SUSPICIOUS_REQUEST',
  'LATE_ARRIVAL',
  'NO_SHOW',
  'FARE',
  'PAYMENT',
  'LOST_PROPERTY',
  'OTHER',
]);

/** Categories that open as urgent, whoever raises them. */
export const DRIVER_HIRE_URGENT_CATEGORIES = Object.freeze(['SAFETY', 'ACCIDENT', 'HARASSMENT']);

export const DRIVER_HIRE_SUPPORT_STATUS = Object.freeze({
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
});

export const DRIVER_HIRE_REVIEW_STATUS = Object.freeze({
  PUBLISHED: 'PUBLISHED',
  HIDDEN: 'HIDDEN',
});

/** Bump when the driver agreement text changes; drivers re-accept to stay eligible. */
export const DRIVER_HIRE_AGREEMENT_VERSION = '2026-10';

const numberFromEnv = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const flagFromEnv = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return String(raw).toLowerCase() !== 'false';
};

/** Operational knobs. Money lives in the versioned pricing rules, not here. */
export const driverHireConfig = () => ({
  quoteValidityMinutes: numberFromEnv('DRIVER_HIRE_QUOTE_VALIDITY_MINUTES', 15),
  // A scheduled booking must be at least this far ahead; NOW has no lead time.
  minScheduleLeadMinutes: numberFromEnv('DRIVER_HIRE_MIN_SCHEDULE_LEAD_MINUTES', 60),
  maxScheduleAheadDays: numberFromEnv('DRIVER_HIRE_MAX_SCHEDULE_AHEAD_DAYS', 30),
  // How long a driver has to answer a booking offered to them.
  offerTimeoutSeconds: numberFromEnv('DRIVER_HIRE_OFFER_TIMEOUT_SECONDS', 120),
  // An unassigned booking expires this long after its pickup time.
  noDriverGraceMinutes: numberFromEnv('DRIVER_HIRE_NO_DRIVER_GRACE_MINUTES', 30),
  // NOW bookings: how long we keep looking before calling it "no driver found".
  nowSearchMinutes: numberFromEnv('DRIVER_HIRE_NOW_SEARCH_MINUTES', 20),
  // A driver can mark Arrived only within this distance of the pickup pin.
  arrivalRadiusMeters: numberFromEnv('DRIVER_HIRE_ARRIVAL_RADIUS_METERS', 300),
  // Night charges and availability slots are read in this zone.
  timezone: process.env.DRIVER_HIRE_TIMEZONE || 'Asia/Kolkata',
  otpLength: numberFromEnv('DRIVER_HIRE_OTP_LENGTH', 4),
  otpMaxAttempts: numberFromEnv('DRIVER_HIRE_OTP_MAX_ATTEMPTS', 5),
  // A driver whose ride drops back to REQUESTED instead of ending it outright.
  reopenOnDriverCancel: flagFromEnv('DRIVER_HIRE_REOPEN_ON_DRIVER_CANCEL', true),
  // Licence-expiry reminders, in days before expiry.
  licenceReminderDays: [30, 7, 1],
  sweepEnabled: flagFromEnv('DRIVER_HIRE_SWEEP_ENABLED', true),
  sweepIntervalMinutes: numberFromEnv('DRIVER_HIRE_SWEEP_INTERVAL_MINUTES', 2),
  // Request cards show the pickup only to this precision until the driver accepts.
  pickupMaskDecimals: 2,
  maxStops: 5,
  maxDurationMinutes: numberFromEnv('DRIVER_HIRE_MAX_DURATION_MINUTES', 24 * 60),
  maxOutstationDays: numberFromEnv('DRIVER_HIRE_MAX_OUTSTATION_DAYS', 15),
});

export const DRIVER_HIRE_ERRORS = Object.freeze({
  INVALID_SERVICE_TYPE: 'INVALID_SERVICE_TYPE',
  INVALID_LOCATION: 'INVALID_LOCATION',
  INVALID_SCHEDULE: 'INVALID_SCHEDULE',
  INVALID_DURATION: 'INVALID_DURATION',
  INVALID_TRANSMISSION: 'INVALID_TRANSMISSION',
  INVALID_PACKAGE: 'INVALID_PACKAGE',
  INVALID_PAYMENT_METHOD: 'INVALID_PAYMENT_METHOD',
  PRICING_NOT_CONFIGURED: 'PRICING_NOT_CONFIGURED',
  INVALID_PRICING: 'INVALID_PRICING',
  QUOTE_NOT_FOUND: 'QUOTE_NOT_FOUND',
  QUOTE_EXPIRED: 'QUOTE_EXPIRED',
  QUOTE_USED: 'QUOTE_USED',
  TERMS_NOT_ACCEPTED: 'TERMS_NOT_ACCEPTED',
  VEHICLE_NOT_FOUND: 'VEHICLE_NOT_FOUND',
  INVALID_VEHICLE: 'INVALID_VEHICLE',
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  NOT_YOUR_BOOKING: 'NOT_YOUR_BOOKING',
  BOOKING_TAKEN: 'BOOKING_TAKEN',
  OFFER_EXPIRED: 'OFFER_EXPIRED',
  DRIVER_NOT_ELIGIBLE: 'DRIVER_NOT_ELIGIBLE',
  DRIVER_BUSY: 'DRIVER_BUSY',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  PROFILE_INCOMPLETE: 'PROFILE_INCOMPLETE',
  AGREEMENT_REQUIRED: 'AGREEMENT_REQUIRED',
  INVALID_DOCUMENT: 'INVALID_DOCUMENT',
  START_NOT_CONFIRMED: 'START_NOT_CONFIRMED',
  INVALID_OTP: 'INVALID_OTP',
  OTP_ATTEMPTS_EXCEEDED: 'OTP_ATTEMPTS_EXCEEDED',
  INVALID_EXPENSE: 'INVALID_EXPENSE',
  INVALID_RATING: 'INVALID_RATING',
  RATING_NOT_ALLOWED: 'RATING_NOT_ALLOWED',
  DUPLICATE_RATING: 'DUPLICATE_RATING',
  INVALID_SUPPORT_CASE: 'INVALID_SUPPORT_CASE',
  SUPPORT_CASE_NOT_FOUND: 'SUPPORT_CASE_NOT_FOUND',
  INVALID_REFUND: 'INVALID_REFUND',
  REASON_REQUIRED: 'REASON_REQUIRED',
});
