import mongoose from 'mongoose';
import { Driver } from '../../driver/models/Driver.js';
import {
  DRIVER_HIRE_ERRORS,
  DRIVER_HIRE_OUTSTATION_TRIP,
  DRIVER_HIRE_PAYMENT_METHODS,
  DRIVER_HIRE_SERVICE_TYPES,
  DRIVER_HIRE_STATUS,
  DRIVER_HIRE_TERMINAL_STATUSES,
  DRIVER_HIRE_TRANSMISSIONS,
  driverHireConfig,
} from '../constants/index.js';
import { DriverHireBooking } from '../models/DriverHireBooking.js';
import { DriverHireProfile } from '../models/DriverHireProfile.js';
import { DriverHireQuote } from '../models/DriverHireQuote.js';
import {
  audit,
  driverHireError,
  isObjectId,
  newBookingCode,
  parsePlace,
  pick,
  runInTransaction,
  toObjectIdOrNull,
} from './common.js';
import { notifyDriverHire } from './notifications.js';
import { recordCancellationFee } from './paymentService.js';
import { buildFare, cancellationFeeFor, getCurrentPricing, termsFromPricing } from './pricingService.js';
import { findEligibleDrivers } from './profileService.js';
import { serializeForCustomer, termsView } from './serializers.js';
import { loadBooking, transition } from './stateMachine.js';
import { requireOwnedVehicle } from './vehicleService.js';

const S = DRIVER_HIRE_STATUS;
const T = DRIVER_HIRE_SERVICE_TYPES;
const MIN_TRIP_MINUTES = 30;

// ── Trip parsing ────────────────────────────────────────────────────────────

const parseScheduledAt = (serviceType, raw) => {
  const config = driverHireConfig();
  const now = Date.now();

  if (serviceType === T.NOW) return new Date(now);

  const at = new Date(raw);
  if (!raw || Number.isNaN(at.getTime())) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_SCHEDULE, 'scheduledAt (date and pickup time) is required.');
  }
  if (at.getTime() < now + config.minScheduleLeadMinutes * 60000) {
    throw driverHireError(
      422,
      DRIVER_HIRE_ERRORS.INVALID_SCHEDULE,
      `Pickup must be at least ${config.minScheduleLeadMinutes} minutes from now. For an immediate driver use Hire Driver Now.`,
    );
  }
  if (at.getTime() > now + config.maxScheduleAheadDays * 86400000) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_SCHEDULE, `Bookings open ${config.maxScheduleAheadDays} days ahead.`);
  }
  return at;
};

const parseMinutes = (payload) => {
  const minutes = pick(payload, 'durationMinutes');
  const hours = pick(payload, 'durationHours');
  const value = minutes !== undefined ? Number(minutes) : Number(hours) * 60;
  if (!Number.isFinite(value) || value < MIN_TRIP_MINUTES || value > driverHireConfig().maxDurationMinutes) {
    throw driverHireError(
      422,
      DRIVER_HIRE_ERRORS.INVALID_DURATION,
      `Duration must be between ${MIN_TRIP_MINUTES} minutes and ${driverHireConfig().maxDurationMinutes / 60} hours.`,
    );
  }
  return Math.round(value);
};

/** Validate and normalise the trip half of a quote request. */
export const parseTrip = (payload) => {
  const config = driverHireConfig();
  const serviceType = String(pick(payload, 'serviceType') || '').toUpperCase();
  if (!Object.values(T).includes(serviceType)) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_SERVICE_TYPE, `serviceType must be one of ${Object.values(T).join(', ')}.`);
  }

  const rawArea = pick(payload, 'serviceLocationId');
  if (rawArea && !isObjectId(rawArea)) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_LOCATION, 'serviceLocationId is not valid.');
  }

  const pickup = parsePlace(payload?.pickup, 'pickup');
  const destination = parsePlace(payload?.destination, 'destination', { required: serviceType === T.OUTSTATION });
  const rawStops = Array.isArray(payload?.stops) ? payload.stops : [];
  if (rawStops.length > config.maxStops) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_LOCATION, `At most ${config.maxStops} stops.`);
  }
  const stops = rawStops.map((stop, index) => parsePlace(stop, `stops[${index}]`));

  const scheduledAt = parseScheduledAt(serviceType, pick(payload, 'scheduledAt'));

  let durationMinutes;
  let nights = 0;
  let outstationTripType = null;
  const eventPackageCode = serviceType === T.EVENT
    ? String(pick(payload, 'eventPackageCode') || '').trim().toUpperCase()
    : null;

  if (serviceType === T.OUTSTATION) {
    outstationTripType = String(pick(payload, 'outstationTripType') || DRIVER_HIRE_OUTSTATION_TRIP.ROUND_TRIP).toUpperCase();
    if (!Object.values(DRIVER_HIRE_OUTSTATION_TRIP).includes(outstationTripType)) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_DURATION, 'outstationTripType must be ONE_WAY or ROUND_TRIP.');
    }
    const days = Number(pick(payload, 'durationDays') ?? 1);
    if (!Number.isInteger(days) || days < 1 || days > config.maxOutstationDays) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_DURATION, `durationDays must be a whole number from 1 to ${config.maxOutstationDays}.`);
    }
    durationMinutes = days * 24 * 60;
    const rawNights = pick(payload, 'nights');
    nights = rawNights === undefined ? days - 1 : Number(rawNights);
    if (!Number.isInteger(nights) || nights < 0 || nights > days) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_DURATION, 'nights must be a whole number no greater than durationDays.');
    }
  } else if (serviceType !== T.EVENT) {
    durationMinutes = parseMinutes(payload);
  }

  const rawTransmission = pick(payload, 'transmission');
  const transmission = rawTransmission ? String(rawTransmission).toUpperCase() : null;
  if (transmission && !Object.values(DRIVER_HIRE_TRANSMISSIONS).includes(transmission)) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_TRANSMISSION, 'transmission must be MANUAL or AUTOMATIC.');
  }

  return {
    serviceType,
    serviceLocationId: toObjectIdOrNull(rawArea),
    pickup,
    destination,
    stops,
    scheduledAt,
    durationMinutes,
    nights,
    outstationTripType,
    eventPackageCode,
    transmission,
  };
};

const priceTrip = (pricing, trip) => {
  const terms = termsFromPricing(pricing);
  let eventPackage = null;
  let { durationMinutes } = trip;

  if (trip.serviceType === T.EVENT) {
    eventPackage = terms.eventPackages.find((pkg) => pkg.code === trip.eventPackageCode);
    if (!eventPackage) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_PACKAGE, 'Choose one of the available event packages.', {
        packages: terms.eventPackages,
      });
    }
    durationMinutes = eventPackage.minutes;
    terms.eventPackage = eventPackage;
  }

  const fare = buildFare(terms, { ...trip, durationMinutes, bookedMinutes: durationMinutes, eventPackage });
  return {
    durationMinutes,
    fare: {
      pricingId: pricing._id,
      pricingVersion: pricing.version,
      currency: pricing.currency,
      ...fare,
      terms,
    },
  };
};

// ── Customer API ────────────────────────────────────────────────────────────

/** POST /driver-bookings/quote — the estimate shown before the customer confirms. */
export const createQuote = async ({ customerId, payload }) => {
  const trip = parseTrip(payload);

  const vehicleId = pick(payload, 'vehicleId');
  if (vehicleId) {
    const vehicle = await requireOwnedVehicle({ vehicleId, customerId });
    trip.transmission = vehicle.transmission;
  }

  const pricing = await getCurrentPricing({ serviceLocationId: trip.serviceLocationId, serviceType: trip.serviceType });
  const { durationMinutes, fare } = priceTrip(pricing, trip);

  const quote = await DriverHireQuote.create({
    ...trip,
    customerId,
    durationMinutes,
    fare,
    expiresAt: new Date(Date.now() + driverHireConfig().quoteValidityMinutes * 60000),
  });

  return {
    quoteId: String(quote._id),
    expiresAt: quote.expiresAt,
    serviceType: quote.serviceType,
    scheduledAt: quote.scheduledAt,
    durationMinutes: quote.durationMinutes,
    nights: quote.nights,
    fare: {
      currency: fare.currency,
      lines: fare.lines,
      subtotal: fare.subtotal,
      tax: fare.tax,
      total: fare.total,
      pricingVersion: fare.pricingVersion,
    },
    terms: termsView(fare.terms),
    eventPackages: trip.serviceType === T.EVENT ? fare.terms.eventPackages : undefined,
  };
};

/** Tell online drivers who could take it that a new request is up. */
const announce = async (booking) => {
  try {
    const eligible = await findEligibleDrivers({ booking, requireOnline: true, limit: 10 });
    for (const { profile } of eligible) {
      notifyDriverHire('OFFER', { booking, driverId: profile.driverId });
    }
  } catch (error) {
    console.error('[driverHire] announce failed', error?.message || error);
  }
};

/**
 * POST /driver-bookings — confirm a quote. Idempotent per quote: repeating the
 * call (a double tap, a retried request) returns the booking already made.
 */
export const createBooking = async ({ customerId, payload }) => {
  const quoteId = pick(payload, 'quoteId');
  if (!isObjectId(quoteId)) {
    throw driverHireError(404, DRIVER_HIRE_ERRORS.QUOTE_NOT_FOUND, 'Quote not found.');
  }
  if (pick(payload, 'acceptTerms') !== true) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.TERMS_NOT_ACCEPTED, 'Accept the fare, cancellation and waiting terms to book.');
  }
  const paymentMethod = String(pick(payload, 'paymentMethod') || DRIVER_HIRE_PAYMENT_METHODS.CASH).toUpperCase();
  if (!Object.values(DRIVER_HIRE_PAYMENT_METHODS).includes(paymentMethod)) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_PAYMENT_METHOD, 'paymentMethod must be CASH or ONLINE.');
  }
  const requirements = String(payload?.requirements || '').trim();
  if (requirements.length > 500) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_VEHICLE, 'requirements must be 500 characters or fewer.');
  }

  const existing = await DriverHireQuote.findOne({ _id: quoteId, customerId }).lean();
  if (!existing) throw driverHireError(404, DRIVER_HIRE_ERRORS.QUOTE_NOT_FOUND, 'Quote not found.');
  if (existing.bookingId) {
    return getBooking({ customerId, bookingId: existing.bookingId });
  }
  if (new Date(existing.expiresAt).getTime() <= Date.now()) {
    throw driverHireError(410, DRIVER_HIRE_ERRORS.QUOTE_EXPIRED, 'This estimate has expired. Get a new one.');
  }

  const vehicle = await requireOwnedVehicle({ vehicleId: pick(payload, 'vehicleId'), customerId });
  if (existing.transmission && existing.transmission !== vehicle.transmission) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_VEHICLE, 'This car has a different transmission from the one quoted. Get a new estimate.');
  }

  let created;
  try {
    created = await runInTransaction(async (session) => {
      const bookingId = new mongoose.Types.ObjectId();
      const quote = await DriverHireQuote.findOneAndUpdate(
        { _id: quoteId, customerId, bookingId: null, expiresAt: { $gt: new Date() } },
        { $set: { bookingId } },
        { returnDocument: 'after', session },
      );
      if (!quote) {
        throw driverHireError(409, DRIVER_HIRE_ERRORS.QUOTE_USED, 'This estimate was already used or has expired.');
      }

      const now = new Date();
      // A NOW booking's clock starts when it is confirmed, not when it was quoted.
      const scheduledAt = quote.serviceType === T.NOW ? now : quote.scheduledAt;
      if (scheduledAt.getTime() < now.getTime() - 60000) {
        throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_SCHEDULE, 'The pickup time has passed. Get a new estimate.');
      }

      const [booking] = await DriverHireBooking.create([{
        _id: bookingId,
        bookingCode: newBookingCode(),
        customerId,
        quoteId: quote._id,
        serviceType: quote.serviceType,
        serviceLocationId: quote.serviceLocationId,
        pickup: quote.pickup,
        destination: quote.destination,
        stops: quote.stops,
        outstationTripType: quote.outstationTripType,
        scheduledAt,
        durationMinutes: quote.durationMinutes,
        nights: quote.nights,
        eventPackageCode: quote.eventPackageCode,
        windowEndsAt: new Date(scheduledAt.getTime() + quote.durationMinutes * 60000),
        vehicle: {
          vehicleId: vehicle._id,
          make: vehicle.make,
          model: vehicle.model,
          transmission: vehicle.transmission,
          notes: vehicle.notes || '',
        },
        requirements,
        fare: quote.fare,
        termsAcceptedAt: now,
        paymentMethod,
        status: S.REQUESTED,
        timeline: [{ status: S.REQUESTED, at: now, actorRole: 'user', actorId: customerId }],
      }], { session });

      await audit({
        actorRole: 'user',
        actorId: customerId,
        action: 'BOOKING_CREATED',
        entityType: 'DriverHireBooking',
        entityId: booking._id,
        changeSummary: { quoteId: String(quote._id), total: quote.fare.total, pricingVersion: quote.fare.pricingVersion },
        session,
      });

      return booking;
    });
  } catch (error) {
    // Lost a race with our own retry: the other request made the booking.
    if (error.code === DRIVER_HIRE_ERRORS.QUOTE_USED) {
      const again = await DriverHireQuote.findById(quoteId).lean();
      if (again?.bookingId) return getBooking({ customerId, bookingId: again.bookingId });
    }
    throw error;
  }

  announce(created);
  return serializeForCustomer(created);
};

const requireCustomerBooking = async ({ customerId, bookingId, withOtp = false }) => {
  const booking = await loadBooking(bookingId, { withOtp });
  // Not found rather than forbidden: an id alone says nothing about whose it is.
  if (String(booking.customerId) !== String(customerId)) {
    throw driverHireError(404, DRIVER_HIRE_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
  }
  return booking;
};

const withDriver = async (booking) => {
  if (!booking.driverId) return { driver: null, profile: null };
  const [driver, profile] = await Promise.all([
    Driver.findById(booking.driverId).select('name rating profileImage profile_picture').lean(),
    DriverHireProfile.findOne({ driverId: booking.driverId }).select('verificationStatus experienceYears ratingAverage ratingCount').lean(),
  ]);
  return { driver, profile };
};

export const getBooking = async ({ customerId, bookingId }) => {
  const booking = await requireCustomerBooking({ customerId, bookingId, withOtp: true });
  return serializeForCustomer(booking, await withDriver(booking));
};

export const listMyBookings = async ({ customerId, scope = '' }) => {
  const filter = { customerId };
  if (scope === 'active') filter.status = { $nin: DRIVER_HIRE_TERMINAL_STATUSES };
  if (scope === 'past') filter.status = { $in: DRIVER_HIRE_TERMINAL_STATUSES };
  const bookings = await DriverHireBooking.find(filter).sort({ scheduledAt: -1 }).limit(50);
  return bookings.map((booking) => serializeForCustomer(booking));
};

/**
 * POST /driver-bookings/{id}/cancel — the customer cancels. The fee is worked
 * out from the status the booking is in at the moment of the update; if a
 * driver moves it on in between, we re-read and try again.
 */
export const cancelByCustomer = async ({ customerId, bookingId, reason }) => {
  const note = String(reason || '').trim();
  if (!note) throw driverHireError(422, DRIVER_HIRE_ERRORS.REASON_REQUIRED, 'Tell us why you are cancelling.');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await requireCustomerBooking({ customerId, bookingId });
    const fee = cancellationFeeFor(current);

    try {
      const booking = await runInTransaction(async (session) => {
        const updated = await transition({
          bookingId: current._id,
          from: [current.status],
          to: S.CANCELLED_BY_CUSTOMER,
          actor: { role: 'user', id: customerId },
          note,
          session,
          set: {
            'cancellation.reason': note.slice(0, 500),
            'cancellation.fee': fee,
            'cancellation.actorId': customerId,
            'offer.driverId': null,
            'offer.expiresAt': null,
            driverLocation: { latitude: null, longitude: null, at: null },
          },
          auditSummary: { from: current.status, fee, reason: note },
        });
        await recordCancellationFee({ booking: updated, fee, session });
        return updated;
      });

      notifyDriverHire('CANCELLED_BY_CUSTOMER', { booking });
      return serializeForCustomer(booking);
    } catch (error) {
      const moved = error.code === DRIVER_HIRE_ERRORS.INVALID_TRANSITION;
      const stillCancellable = moved && [S.REQUESTED, S.DRIVER_ASSIGNED, S.DRIVER_EN_ROUTE, S.DRIVER_ARRIVED]
        .includes(error.details?.status);
      if (!stillCancellable) throw error;
    }
  }

  throw driverHireError(409, DRIVER_HIRE_ERRORS.INVALID_TRANSITION, 'The booking changed while cancelling. Try again.');
};

/** The customer confirms in-app that the driver has arrived — one way to allow Start. */
export const confirmArrival = async ({ customerId, bookingId }) => {
  const current = await requireCustomerBooking({ customerId, bookingId });
  const booking = await transition({
    bookingId: current._id,
    from: [S.DRIVER_ARRIVED],
    to: S.DRIVER_ARRIVED,
    event: 'CUSTOMER_CONFIRMED_ARRIVAL',
    actor: { role: 'user', id: customerId },
    filter: { customerConfirmedArrivalAt: null },
    set: { customerConfirmedArrivalAt: new Date() },
    conflict: { code: DRIVER_HIRE_ERRORS.INVALID_TRANSITION, message: 'Arrival is already confirmed.' },
  });
  const full = await loadBooking(booking._id, { withOtp: true });
  return serializeForCustomer(full, await withDriver(full));
};

/**
 * GET /drivers/availability — for the customer, a count only. Who the drivers
 * are is not theirs to see before one accepts.
 */
export const checkAvailability = async ({ query }) => {
  const serviceType = String(query?.serviceType || '').toUpperCase();
  const transmission = String(query?.transmission || '').toUpperCase();
  if (!Object.values(T).includes(serviceType)) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_SERVICE_TYPE, 'serviceType is required.');
  }
  if (!Object.values(DRIVER_HIRE_TRANSMISSIONS).includes(transmission)) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_TRANSMISSION, 'transmission is required.');
  }
  const scheduledAt = query?.scheduledAt ? new Date(query.scheduledAt) : new Date();
  if (Number.isNaN(scheduledAt.getTime())) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_SCHEDULE, 'scheduledAt is not a date.');
  }
  const minutes = Math.max(MIN_TRIP_MINUTES, Number(query?.durationMinutes) || 120);
  const probe = {
    _id: new mongoose.Types.ObjectId(),
    serviceType,
    serviceLocationId: toObjectIdOrNull(query?.serviceLocationId),
    scheduledAt,
    windowEndsAt: new Date(scheduledAt.getTime() + minutes * 60000),
    vehicle: { transmission },
    declinedDriverIds: [],
  };
  const drivers = await findEligibleDrivers({ booking: probe, requireOnline: serviceType === T.NOW, limit: 50 });
  return { available: drivers.length > 0, count: drivers.length };
};
