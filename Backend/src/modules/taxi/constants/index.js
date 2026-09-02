export const RIDE_STATUS = Object.freeze({
  SEARCHING: 'searching',
  ACCEPTED: 'accepted',
  ONGOING: 'ongoing',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

export const RIDE_LIVE_STATUS = Object.freeze({
  SEARCHING: 'searching',
  ACCEPTED: 'accepted',
  ARRIVING: 'arriving',
  STARTED: 'started',
  ARRIVED: 'arrived',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

export const RIDE_CANCELLED_BY = Object.freeze({
  USER: 'user',
  DRIVER: 'driver',
  ADMIN: 'admin',
  SYSTEM: 'system',
});

// Shown to the rider as a pick-list before a cancellation is accepted.
// `label` is the default copy; clients may localise it, the `code` is the stable key.
export const USER_CANCEL_REASONS = Object.freeze([
  { code: 'driver_taking_too_long', label: 'Driver is taking too long' },
  { code: 'driver_not_moving', label: 'Driver is not moving towards pickup' },
  { code: 'wrong_pickup_location', label: 'Wrong pickup location' },
  { code: 'booked_by_mistake', label: 'Booked by mistake' },
  { code: 'changed_plans', label: 'My plans changed' },
  { code: 'found_another_ride', label: 'Found another ride' },
  { code: 'fare_too_high', label: 'Fare is too high' },
  { code: 'driver_asked_to_cancel', label: 'Driver asked me to cancel' },
  { code: 'other', label: 'Other' },
]);

export const USER_CANCEL_REASON_CODES = Object.freeze(
  USER_CANCEL_REASONS.map((reason) => reason.code),
);

// Recorded when a client cancels without supplying a reason (older app builds).
export const CANCEL_REASON_UNSPECIFIED = 'unspecified';

export const VEHICLE_TYPES = Object.freeze(['bike', 'auto', 'car']);

export const MEDICINE_DELIVERY_TYPES = Object.freeze([
  'home_to_pharmacy',
  'pharmacy_to_home',
  'hospital_pickup',
  'document_pickup',
  'sample_pickup',
  'return_pickup',
]);

export const DISPATCH_RADII = Object.freeze([2500, 4000, 6000, 8000, 10000, 15000]);
export const DISPATCH_INTERCITY_RADII = Object.freeze([10000, 20000, 35000, 50000]);
export const DISPATCH_TOP_DRIVERS = 5;
export const DISPATCH_RETRY_DELAY_MS = 8000;
