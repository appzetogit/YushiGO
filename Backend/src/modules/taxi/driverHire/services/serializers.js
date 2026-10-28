import { decryptField } from '../../../../utils/fieldCrypto.js';
import { DRIVER_HIRE_STATUS, DRIVER_HIRE_TERMINAL_STATUSES, driverHireConfig } from '../constants/index.js';
import { cancellationFeeFor } from './pricingService.js';

/**
 * Three views of one booking (spec §3, §8): the customer's, the driver's and
 * the admin's. Each is built from an allow-list, so a field added to the model
 * is invisible until someone decides who may see it.
 */

const S = DRIVER_HIRE_STATUS;
const TRACKABLE = [S.DRIVER_EN_ROUTE, S.DRIVER_ARRIVED, S.TRIP_STARTED];
const CUSTOMER_CANCELLABLE = [S.REQUESTED, S.DRIVER_ASSIGNED, S.DRIVER_EN_ROUTE, S.DRIVER_ARRIVED];

const id = (value) => (value ? String(value._id || value) : null);

const place = (value) => (value ? { address: value.address, latitude: value.latitude, longitude: value.longitude } : null);

const fareView = (fare, { forDriver = false } = {}) => {
  if (!fare) return null;
  if (forDriver) {
    return { currency: fare.currency, estimatedEarnings: fare.driverAmount };
  }
  return {
    currency: fare.currency,
    lines: (fare.lines || []).map(({ code, label, amount, passThrough }) => ({ code, label, amount, passThrough: Boolean(passThrough) })),
    subtotal: fare.subtotal,
    tax: fare.tax,
    total: fare.total,
    pricingVersion: fare.pricingVersion,
  };
};

const finalView = (booking, { forDriver = false } = {}) => {
  const final = booking.final;
  if (!final || final.total === null || final.total === undefined) return null;
  const base = {
    actualMinutes: final.actualMinutes,
    waitingMinutes: final.waitingMinutes,
    expenses: (final.expenses || []).map(({ kind, amount, note }) => ({ kind, amount, note })),
  };
  if (forDriver) return { ...base, earnings: final.driverAmount, total: final.total };
  return {
    ...base,
    lines: (final.lines || []).map(({ code, label, amount, passThrough }) => ({ code, label, amount, passThrough: Boolean(passThrough) })),
    subtotal: final.subtotal,
    tax: final.tax,
    total: final.total,
  };
};

/** The customer-facing terms: what can change the price, and what cancelling costs. */
export const termsView = (terms = {}) => ({
  includedMinutes: terms.includedMinutes,
  minimumMinutes: terms.minimumMinutes,
  extraBlockMinutes: terms.extraBlockMinutes,
  extraBlockFare: terms.extraBlockFare,
  freeWaitingMinutes: terms.freeWaitingMinutes,
  waitingPerMinute: terms.waitingPerMinute,
  overnightAllowance: terms.overnightAllowance,
  dailyAllowance: terms.dailyAllowance,
  freeCancelMinutes: terms.freeCancelMinutes,
  freeCancelBeforePickupMinutes: terms.freeCancelBeforePickupMinutes,
  cancellationFee: terms.cancellationFee,
  lateCancellationFee: terms.lateCancellationFee,
  noShowWaitMinutes: terms.noShowWaitMinutes,
  noShowFee: terms.noShowFee,
  tollsAndParking: terms.allowDriverExpenses
    ? 'Paid by you. If your driver pays one for you, it is added to the final bill at cost.'
    : 'Paid by you directly.',
  finalFareNote: 'The final fare can be higher than this estimate if the trip runs longer than booked, waiting exceeds the free time, an outstation trip needs extra days or nights, or tolls and parking are paid on your behalf.',
});

const driverCard = (driver, profile) => {
  if (!driver) return null;
  const name = String(driver.name || '').trim();
  const [first, ...rest] = name.split(/\s+/);
  return {
    id: id(driver),
    // First name and initial only: enough to greet, not enough to look up.
    name: rest.length ? `${first} ${rest[rest.length - 1][0]}.` : first,
    photo: driver.profileImage || driver.profile_picture || '',
    rating: Number(profile?.ratingAverage || 0),
    ratingCount: Number(profile?.ratingCount || 0),
    verified: profile?.verificationStatus === 'APPROVED',
    experienceYears: profile?.experienceYears || 0,
  };
};

const timelineView = (timeline = []) => timeline
  .filter((entry) => !entry.event)
  .map(({ status, at }) => ({ status, at }));

export const serializeForCustomer = (booking, { driver = null, profile = null } = {}) => {
  const showOtp = [S.DRIVER_ASSIGNED, S.DRIVER_EN_ROUTE, S.DRIVER_ARRIVED].includes(booking.status);
  const cancellable = CUSTOMER_CANCELLABLE.includes(booking.status);
  return {
    id: id(booking),
    bookingCode: booking.bookingCode,
    status: booking.status,
    serviceType: booking.serviceType,
    pickup: place(booking.pickup),
    destination: place(booking.destination),
    stops: (booking.stops || []).map(place),
    outstationTripType: booking.outstationTripType,
    scheduledAt: booking.scheduledAt,
    durationMinutes: booking.durationMinutes,
    nights: booking.nights,
    eventPackageCode: booking.eventPackageCode,
    vehicle: { make: booking.vehicle.make, model: booking.vehicle.model, transmission: booking.vehicle.transmission },
    requirements: booking.requirements || '',
    paymentMethod: booking.paymentMethod,
    fare: fareView(booking.fare),
    terms: termsView(booking.fare?.terms),
    final: finalView(booking),
    driver: driverCard(driver, profile),
    startCode: showOtp && booking.startOtp?.code ? decryptField(booking.startOtp.code) : null,
    driverLocation: TRACKABLE.includes(booking.status) && booking.driverLocation?.at ? booking.driverLocation : null,
    timeline: timelineView(booking.timeline),
    cancellation: booking.cancelledAt ? {
      reason: booking.cancellation?.reason || '',
      fee: booking.cancellation?.fee || 0,
      noShow: Boolean(booking.cancellation?.noShow),
      at: booking.cancelledAt,
    } : null,
    canCancel: cancellable,
    cancellationFeeIfCancelledNow: cancellable ? cancellationFeeFor(booking) : null,
    canConfirmArrival: booking.status === S.DRIVER_ARRIVED && !booking.customerConfirmedArrivalAt,
    canRate: booking.status === S.TRIP_COMPLETED && !booking.customerRated,
    createdAt: booking.createdAt,
  };
};

const maskCoordinate = (value) => {
  const decimals = driverHireConfig().pickupMaskDecimals;
  return Math.round(value * 10 ** decimals) / 10 ** decimals;
};

/** A request card: enough to decide, nothing more (spec §3). */
export const serializeRequestCard = (booking, { driverId } = {}) => ({
  id: id(booking),
  bookingCode: booking.bookingCode,
  serviceType: booking.serviceType,
  pickupArea: { latitude: maskCoordinate(booking.pickup.latitude), longitude: maskCoordinate(booking.pickup.longitude) },
  destinationArea: booking.destination
    ? { latitude: maskCoordinate(booking.destination.latitude), longitude: maskCoordinate(booking.destination.longitude) }
    : null,
  outstationTripType: booking.outstationTripType,
  scheduledAt: booking.scheduledAt,
  durationMinutes: booking.durationMinutes,
  nights: booking.nights,
  transmission: booking.vehicle.transmission,
  fare: fareView(booking.fare, { forDriver: true }),
  offeredToYou: Boolean(driverId && id(booking.offer?.driverId) === String(driverId)),
  offerExpiresAt: booking.offer?.expiresAt || null,
});

export const serializeForDriver = (booking, { customer = null } = {}) => ({
  id: id(booking),
  bookingCode: booking.bookingCode,
  status: booking.status,
  serviceType: booking.serviceType,
  pickup: place(booking.pickup),
  destination: place(booking.destination),
  stops: (booking.stops || []).map(place),
  outstationTripType: booking.outstationTripType,
  scheduledAt: booking.scheduledAt,
  durationMinutes: booking.durationMinutes,
  nights: booking.nights,
  vehicle: { make: booking.vehicle.make, model: booking.vehicle.model, transmission: booking.vehicle.transmission, notes: booking.vehicle.notes || '' },
  requirements: booking.requirements || '',
  paymentMethod: booking.paymentMethod,
  customer: customer ? { firstName: String(customer.name || '').trim().split(/\s+/)[0] || 'Customer' } : null,
  fare: fareView(booking.fare, { forDriver: true }),
  final: finalView(booking, { forDriver: true }),
  timeline: timelineView(booking.timeline),
  arrivedAt: booking.arrivedAt,
  startedAt: booking.startedAt,
  noShowAvailableAt: booking.status === S.DRIVER_ARRIVED && booking.arrivedAt
    ? new Date(new Date(booking.arrivedAt).getTime() + (booking.fare?.terms?.noShowWaitMinutes || 30) * 60000)
    : null,
  customerConfirmedArrival: Boolean(booking.customerConfirmedArrivalAt),
  canRate: booking.status === S.TRIP_COMPLETED && !booking.driverRated,
  isFinished: DRIVER_HIRE_TERMINAL_STATUSES.includes(booking.status),
});

export const serializeForAdmin = (booking) => {
  const plain = typeof booking.toObject === 'function' ? booking.toObject() : { ...booking };
  delete plain.startOtp;
  return {
    ...plain,
    id: id(booking),
    customer: plain.customerId?.name !== undefined
      ? { id: id(plain.customerId), name: plain.customerId.name || '', phone: plain.customerId.phone || '' }
      : null,
    driver: plain.driverId?.name !== undefined
      ? { id: id(plain.driverId), name: plain.driverId.name || '', phone: plain.driverId.phone || '' }
      : null,
    customerId: id(plain.customerId),
    driverId: id(plain.driverId),
  };
};
