/**
 * Parcel rules that shared ride code consults.
 *
 * Zero imports on purpose: rideService and dispatchService call into this on
 * every ride, so it must be cheap, cycle-free and a no-op for anything that is
 * not a parcel.
 */

export const PARCEL_SIZES = Object.freeze(['small', 'medium', 'large', 'custom']);

/** Ordering used to check a parcel against a vehicle's largest accepted size. */
export const parcelSizeRank = (size) => PARCEL_SIZES.indexOf(String(size || '').toLowerCase());

const flag = (key, fallback = false) => {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : String(raw).toLowerCase() === 'true';
};

const numberFromEnv = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * PARCEL_OTP_ENFORCED switches on the new parcel contract as a whole:
 * photo and size required at booking, the OTP hidden from the ride payloads,
 * and the step order (parcel verified → pickup OTP → drop OTP) enforced.
 *
 * Off by default because the current driver app checks the ride OTP on the
 * phone and has no "Parcel verified" step: hiding the code before that app is
 * replaced would leave every parcel stuck at pickup.
 */
export const parcelConfig = () => ({
  enforced: flag('PARCEL_OTP_ENFORCED'),
  otpLength: numberFromEnv('PARCEL_OTP_LENGTH', 4),
  otpMaxAttempts: numberFromEnv('PARCEL_OTP_MAX_ATTEMPTS', 5),
  pickupOtpExpiryMinutes: numberFromEnv('PARCEL_PICKUP_OTP_EXPIRY_MINUTES', 60),
  dropOtpExpiryMinutes: numberFromEnv('PARCEL_DROP_OTP_EXPIRY_MINUTES', 24 * 60),
  maxWeightKg: numberFromEnv('PARCEL_MAX_WEIGHT_KG', 500),
  maxDimensionCm: numberFromEnv('PARCEL_MAX_DIMENSION_CM', 300),
  maxPhotoBytes: numberFromEnv('PARCEL_MAX_PHOTO_BYTES', 5 * 1024 * 1024),
});

const isParcel = (ride) => String(ride?.serviceType || '').toLowerCase() === 'parcel';

/**
 * Whether the generic `ride.otp` may be sent for this ride.
 *
 * Always true for non-parcel rides — the check is the first thing done, so
 * every other ride serializes exactly as before.
 */
export const rideOtpVisible = (ride) => !(isParcel(ride) && parcelConfig().enforced);

/** The ride's otp as it may be shown: unchanged, or '' for an enforced parcel. */
export const visibleRideOtp = (ride) => (rideOtpVisible(ride) ? ride?.otp || '' : '');

/**
 * Refuse a lifecycle step a parcel has not earned. Returns an error message or
 * null. Only for parcels with enforcement on.
 */
export const parcelStepBlocker = (ride, nextStatus) => {
  if (!isParcel(ride) || !parcelConfig().enforced) {
    return null;
  }

  const handover = ride.parcelHandover || {};

  if (nextStatus === 'started' && !handover.pickupOtpVerified) {
    return 'Verify the parcel and the sender\'s pickup OTP before starting the delivery.';
  }

  if (nextStatus === 'completed' && !handover.dropOtpVerified) {
    return 'Verify the receiver\'s drop OTP before completing the delivery.';
  }

  return null;
};

/** Parse a weight in kg from a number or a label like "5", "5 kg", "2.5kg". */
export const parseWeightKg = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const match = String(value).replace(',', '.').match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
};
