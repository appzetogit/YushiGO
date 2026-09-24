export const CARPOOL_RIDE_STATUS = Object.freeze({
  PUBLISHED: 'PUBLISHED',
  FULL: 'FULL',
  STARTED: 'STARTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
});

/** Ride status is separate from booking status and the two never share a value space. */
export const CARPOOL_BOOKING_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
});

export const CARPOOL_PAYMENT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  NOT_REQUIRED: 'NOT_REQUIRED',
});

/** Rides a passenger may still be matched against. */
export const CARPOOL_SEARCHABLE_STATUSES = Object.freeze([CARPOOL_RIDE_STATUS.PUBLISHED]);

export const CARPOOL_VEHICLE_VERIFICATION = Object.freeze({
  UNVERIFIED: 'UNVERIFIED',
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
});

const numberFromEnv = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * Matching thresholds are configuration, not constants in the code — §14.1 calls
 * for tuning these per market without a deploy.
 */
export const carpoolConfig = () => ({
  pickupRouteToleranceKm: numberFromEnv('CARPOOL_PICKUP_TOLERANCE_KM', 3),
  dropRouteToleranceKm: numberFromEnv('CARPOOL_DROP_TOLERANCE_KM', 3),
  maxSeatsPerRide: numberFromEnv('CARPOOL_MAX_SEATS_PER_RIDE', 8),
  maxSeatsPerBooking: numberFromEnv('CARPOOL_MAX_SEATS_PER_BOOKING', 4),
  maxPricePerSeat: numberFromEnv('CARPOOL_MAX_PRICE_PER_SEAT', 10000),
  searchLimit: numberFromEnv('CARPOOL_SEARCH_LIMIT', 50),
  // Publishing requires approved host documents (driver photo, licence, RC,
  // insurance). CARPOOL_REQUIRE_VERIFIED_VEHICLE=false switches the gate off.
  requireVerifiedVehicle: String(process.env.CARPOOL_REQUIRE_VERIFIED_VEHICLE ?? 'true').toLowerCase() !== 'false',
  // Cash between users for now. The settlement seam in carpoolSettlement.js is
  // where a wallet or gateway model attaches.
  instantBooking: String(process.env.CARPOOL_INSTANT_BOOKING || '').toLowerCase() === 'true',
  // How long after departure a ride that never started is still a ride. A host
  // leaving at 09:00 must still be able to press Start at 09:12.
  expiryGraceMinutes: numberFromEnv('CARPOOL_EXPIRY_GRACE_MINUTES', 120),
  expirySweepEnabled: String(process.env.CARPOOL_EXPIRY_SWEEP_ENABLED ?? 'true').toLowerCase() !== 'false',
  expirySweepIntervalMinutes: numberFromEnv('CARPOOL_EXPIRY_SWEEP_INTERVAL_MINUTES', 5),
});

export const CARPOOL_ERRORS = Object.freeze({
  RIDE_NOT_FOUND: 'RIDE_NOT_FOUND',
  RIDE_NOT_AVAILABLE: 'RIDE_NOT_AVAILABLE',
  SEATS_UNAVAILABLE: 'SEATS_UNAVAILABLE',
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  BOOKING_ALREADY_PROCESSED: 'BOOKING_ALREADY_PROCESSED',
  DUPLICATE_BOOKING: 'DUPLICATE_BOOKING',
  INVALID_ROUTE: 'INVALID_ROUTE',
  INVALID_PICKUP: 'INVALID_PICKUP',
  INVALID_DROP: 'INVALID_DROP',
  RIDE_CANCELLED: 'RIDE_CANCELLED',
  RIDE_STARTED: 'RIDE_STARTED',
  RIDE_COMPLETED: 'RIDE_COMPLETED',
  UNAUTHORIZED_RIDE_ACCESS: 'UNAUTHORIZED_RIDE_ACCESS',
  INVALID_VEHICLE: 'INVALID_VEHICLE',
  VEHICLE_NOT_VERIFIED: 'VEHICLE_NOT_VERIFIED',
  LOCATION_INVALID: 'LOCATION_INVALID',
  CANNOT_BOOK_OWN_RIDE: 'CANNOT_BOOK_OWN_RIDE',
  WOMEN_ONLY_RESTRICTED: 'WOMEN_ONLY_RESTRICTED',
  RATING_NOT_ALLOWED: 'RATING_NOT_ALLOWED',
  DUPLICATE_RATING: 'DUPLICATE_RATING',
  RIDE_EXPIRED: 'RIDE_EXPIRED',
  INVALID_DOCUMENT: 'INVALID_DOCUMENT',
  DOCUMENT_EXPIRED: 'DOCUMENT_EXPIRED',
  PRICE_ABOVE_LIMIT: 'PRICE_ABOVE_LIMIT',
  OUTSIDE_ROUTE: 'OUTSIDE_ROUTE',
  INVALID_OFFER: 'INVALID_OFFER',
  DOOR_TO_DOOR_UNAVAILABLE: 'DOOR_TO_DOOR_UNAVAILABLE',
});

export const CARPOOL_NEGOTIATION_STATUS = Object.freeze({
  NONE: 'none',
  OFFERED: 'offered',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
});
