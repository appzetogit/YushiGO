import { decryptField, encryptField } from '../../../../utils/fieldCrypto.js';
import { Driver } from '../../driver/models/Driver.js';
import { User } from '../../user/models/User.js';
import {
  DRIVER_HIRE_ERRORS,
  DRIVER_HIRE_PROFILE_STATUS,
  DRIVER_HIRE_SERVICE_TYPES,
  DRIVER_HIRE_STATUS,
  DRIVER_HIRE_TERMINAL_STATUSES,
  driverHireConfig,
} from '../constants/index.js';
import { DriverHireBooking } from '../models/DriverHireBooking.js';
import { DriverHireProfile } from '../models/DriverHireProfile.js';
import { DriverHirePayment } from '../models/DriverHireRecords.js';
import { codesMatch, distanceMeters, driverHireError, newOtp, roundMoney, runInTransaction } from './common.js';
import { notifyDriverHire } from './notifications.js';
import { recordCancellationFee, recordTripPayment } from './paymentService.js';
import { buildFare } from './pricingService.js';
import { eligibilityBlocker, isDriverBusy } from './profileService.js';
import { serializeForDriver, serializeRequestCard } from './serializers.js';
import { loadBooking, transition } from './stateMachine.js';

/**
 * The driver's side of a booking (spec §3) and the assignment logic admins
 * share with it: accept, decline, on the way, arrived, start, complete, and
 * the ways out — release, no-show.
 */

const S = DRIVER_HIRE_STATUS;
const CLEARED_LOCATION = { latitude: null, longitude: null, at: null };
const CLEARED_OFFER = { 'offer.driverId': null, 'offer.offeredAt': null, 'offer.expiresAt': null, 'offer.offeredBy': null };

const requireProfile = async (driverId) => {
  const profile = await DriverHireProfile.findOne({ driverId }).lean();
  if (!profile) {
    throw driverHireError(404, DRIVER_HIRE_ERRORS.PROFILE_NOT_FOUND, 'Complete your Search a Driver profile first.');
  }
  return profile;
};

const requireAssigned = async ({ driverId, bookingId, withOtp = false }) => {
  const booking = await loadBooking(bookingId, { withOtp });
  if (String(booking.driverId || '') !== String(driverId)) {
    throw driverHireError(404, DRIVER_HIRE_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
  }
  return booking;
};

const asDriver = async (booking) => {
  const customer = await User.findById(booking.customerId).select('name').lean();
  return serializeForDriver(booking, { customer });
};

const liveOfferFilter = (driverId, now = new Date()) => ({
  $or: [
    { 'offer.driverId': null },
    { 'offer.expiresAt': { $lte: now } },
    { 'offer.driverId': driverId },
  ],
});

// ── Assignment (driver accept and admin assign share this) ──────────────────

/**
 * Put `driverId` on a REQUESTED booking. One transaction: re-check eligibility
 * and the busy window, then a conditional update. The profile write makes two
 * parallel assignments of the same driver conflict (see assignmentSeq).
 */
export const assignDriver = async ({ bookingId, driverId, actor, requireOnline, respectOffer = true }) => {
  const otp = newOtp();

  const booking = await runInTransaction(async (session) => {
    const profile = await DriverHireProfile.findOneAndUpdate(
      { driverId },
      { $inc: { assignmentSeq: 1 } },
      { returnDocument: 'after', session },
    );
    const [current, driver] = await Promise.all([
      loadBooking(bookingId, { session }),
      Driver.findById(driverId).select('deletedAt approve').session(session).lean(),
    ]);

    if (current.status !== S.REQUESTED) {
      throw driverHireError(409, DRIVER_HIRE_ERRORS.BOOKING_TAKEN, 'This booking is no longer available.');
    }
    const blocker = eligibilityBlocker(profile, current, { requireOnline, driver });
    if (blocker) throw driverHireError(403, DRIVER_HIRE_ERRORS.DRIVER_NOT_ELIGIBLE, blocker);
    if (await isDriverBusy({ driverId, booking: current, session })) {
      throw driverHireError(409, DRIVER_HIRE_ERRORS.DRIVER_BUSY, 'This driver already has a booking at that time.');
    }

    return transition({
      bookingId,
      from: [S.REQUESTED],
      to: S.DRIVER_ASSIGNED,
      actor,
      session,
      filter: {
        declinedDriverIds: { $ne: driverId },
        ...(respectOffer ? liveOfferFilter(driverId) : {}),
      },
      set: {
        driverId,
        ...CLEARED_OFFER,
        startOtp: { code: encryptField(otp), issuedAt: new Date(), verifiedAt: null, attempts: 0 },
        customerConfirmedArrivalAt: null,
      },
      conflict: { code: DRIVER_HIRE_ERRORS.BOOKING_TAKEN, message: 'This booking was just offered to another driver.' },
      auditSummary: { driverId: String(driverId), by: actor.role },
    });
  });

  notifyDriverHire('DRIVER_ASSIGNED', { booking });
  return booking;
};

/** Admin: put the booking in front of one driver, who has a short time to answer. */
export const offerToDriver = async ({ bookingId, driverId, actor }) => {
  const [profile, current, driver] = await Promise.all([
    DriverHireProfile.findOne({ driverId }).lean(),
    loadBooking(bookingId),
    Driver.findById(driverId).select('deletedAt approve').lean(),
  ]);
  if (current.status !== S.REQUESTED) {
    throw driverHireError(409, DRIVER_HIRE_ERRORS.INVALID_TRANSITION, 'Only an unassigned booking can be offered.');
  }
  const blocker = eligibilityBlocker(profile, current, { driver });
  if (blocker) throw driverHireError(403, DRIVER_HIRE_ERRORS.DRIVER_NOT_ELIGIBLE, blocker);
  if (await isDriverBusy({ driverId, booking: current })) {
    throw driverHireError(409, DRIVER_HIRE_ERRORS.DRIVER_BUSY, 'This driver already has a booking at that time.');
  }

  const now = new Date();
  const booking = await transition({
    bookingId,
    from: [S.REQUESTED],
    to: S.REQUESTED,
    event: 'OFFERED',
    actor,
    filter: { 'offer.driverId': { $ne: driverId } },
    set: {
      'offer.driverId': driverId,
      'offer.offeredAt': now,
      'offer.expiresAt': new Date(now.getTime() + driverHireConfig().offerTimeoutSeconds * 1000),
      'offer.offeredBy': actor.role === 'admin' ? 'admin' : 'system',
    },
    conflict: { code: DRIVER_HIRE_ERRORS.BOOKING_TAKEN, message: 'This booking is already offered to that driver.' },
    auditSummary: { driverId: String(driverId) },
  });

  notifyDriverHire('OFFER', { booking, driverId });
  return booking;
};

/**
 * Take a driver off a booking before the trip starts — the driver cancelling,
 * or an admin reassigning. The booking goes back to REQUESTED for someone else
 * while there is still time; otherwise it ends as cancelled by the driver.
 */
export const releaseDriver = async ({ bookingId, actor, reason, expectedDriverId = null, forceReopen = false }) => {
  const note = String(reason || '').trim();
  if (!note) throw driverHireError(422, DRIVER_HIRE_ERRORS.REASON_REQUIRED, 'A reason is required.');

  const current = await loadBooking(bookingId);
  if (expectedDriverId && String(current.driverId || '') !== String(expectedDriverId)) {
    throw driverHireError(404, DRIVER_HIRE_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
  }
  const driverId = current.driverId;
  const config = driverHireConfig();
  const deadline = new Date(current.scheduledAt).getTime() + config.noDriverGraceMinutes * 60000;
  const reopen = forceReopen || (config.reopenOnDriverCancel && deadline > Date.now());
  const from = [S.DRIVER_ASSIGNED, S.DRIVER_EN_ROUTE, S.DRIVER_ARRIVED];

  const booking = await runInTransaction(async (session) => {
    const updated = reopen
      ? await transition({
        bookingId,
        from,
        to: S.REQUESTED,
        event: 'DRIVER_RELEASED',
        actor,
        note,
        session,
        filter: { driverId },
        set: {
          driverId: null,
          assignedAt: null,
          enRouteAt: null,
          arrivedAt: null,
          customerConfirmedArrivalAt: null,
          startOtp: { code: '', issuedAt: null, verifiedAt: null, attempts: 0 },
          driverLocation: CLEARED_LOCATION,
          ...CLEARED_OFFER,
        },
        push: { declinedDriverIds: driverId },
        auditSummary: { driverId: String(driverId), reason: note, reopened: true },
      })
      : await transition({
        bookingId,
        from,
        to: S.CANCELLED_BY_DRIVER,
        actor,
        note,
        session,
        filter: { driverId },
        set: {
          'cancellation.reason': note.slice(0, 500),
          'cancellation.actorId': actor.id || null,
          driverLocation: CLEARED_LOCATION,
        },
        auditSummary: { driverId: String(driverId), reason: note, reopened: false },
      });

    if (actor.role === 'driver') {
      await DriverHireProfile.updateOne({ driverId }, { $inc: { cancellationsAfterAccept: 1 } }, { session });
    }
    return updated;
  });

  notifyDriverHire(reopen ? 'DRIVER_RELEASED' : 'CANCELLED_BY_DRIVER', { booking, customerId: booking.customerId });
  return booking;
};

// ── Driver API ──────────────────────────────────────────────────────────────

/**
 * Open requests this driver could take: offered to them, or unclaimed and a
 * match for their profile. Cards only — no address until they accept.
 */
export const listRequests = async ({ driverId }) => {
  const profile = await requireProfile(driverId);
  if (profile.verificationStatus !== DRIVER_HIRE_PROFILE_STATUS.APPROVED) return [];

  const now = new Date();
  const filter = {
    status: S.REQUESTED,
    declinedDriverIds: { $ne: driverId },
    'vehicle.transmission': { $in: profile.transmissions },
    serviceType: { $in: profile.serviceTypes },
    ...liveOfferFilter(driverId, now),
  };
  if (profile.serviceLocationIds?.length) {
    filter.$and = [{ $or: [{ serviceLocationId: null }, { serviceLocationId: { $in: profile.serviceLocationIds } }] }];
  }

  const candidates = await DriverHireBooking.find(filter).sort({ scheduledAt: 1 }).limit(100);
  const cards = [];
  for (const booking of candidates) {
    const offeredToMe = String(booking.offer?.driverId || '') === String(driverId)
      && booking.offer?.expiresAt && new Date(booking.offer.expiresAt) > now;
    // Offline drivers still see what was offered to them directly.
    const blocker = eligibilityBlocker(profile, booking, { requireOnline: !offeredToMe });
    if (blocker) continue;
    if (await isDriverBusy({ driverId, booking })) continue;
    cards.push(serializeRequestCard(booking, { driverId }));
    if (cards.length >= 30) break;
  }
  return cards;
};

export const acceptBooking = async ({ driverId, bookingId }) => {
  const current = await loadBooking(bookingId);
  const booking = await assignDriver({
    bookingId,
    driverId,
    actor: { role: 'driver', id: driverId },
    // A NOW booking needs someone online; a scheduled one can be accepted ahead of time.
    requireOnline: current.serviceType === DRIVER_HIRE_SERVICE_TYPES.NOW,
  });
  return asDriver(booking);
};

export const declineBooking = async ({ driverId, bookingId, reason = '' }) => {
  await transition({
    bookingId,
    from: [S.REQUESTED],
    to: S.REQUESTED,
    event: 'OFFER_DECLINED',
    actor: { role: 'driver', id: driverId },
    note: reason,
    filter: { declinedDriverIds: { $ne: driverId } },
    set: {},
    push: { declinedDriverIds: driverId },
    conflict: { code: DRIVER_HIRE_ERRORS.INVALID_TRANSITION, message: 'Already declined.' },
  });
  // Clear the offer only if it was this driver's.
  await DriverHireBooking.updateOne({ _id: bookingId, 'offer.driverId': driverId }, { $set: CLEARED_OFFER });
  return { declined: true };
};

export const getDriverBooking = async ({ driverId, bookingId }) => {
  const booking = await loadBooking(bookingId);
  if (String(booking.driverId || '') === String(driverId)) return asDriver(booking);

  // Not theirs yet: a request card, if it is one they could take.
  if (booking.status === S.REQUESTED && !(booking.declinedDriverIds || []).some((id) => String(id) === String(driverId))) {
    return { request: serializeRequestCard(booking, { driverId }) };
  }
  throw driverHireError(404, DRIVER_HIRE_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
};

export const listDriverBookings = async ({ driverId, scope = '' }) => {
  const filter = { driverId };
  if (scope === 'active') filter.status = { $nin: DRIVER_HIRE_TERMINAL_STATUSES };
  if (scope === 'past') filter.status = { $in: DRIVER_HIRE_TERMINAL_STATUSES };
  const bookings = await DriverHireBooking.find(filter).sort({ scheduledAt: scope === 'active' ? 1 : -1 }).limit(50);
  return bookings.map((booking) => serializeForDriver(booking));
};

export const markEnRoute = async ({ driverId, bookingId }) => {
  await requireAssigned({ driverId, bookingId });
  const booking = await transition({
    bookingId,
    from: [S.DRIVER_ASSIGNED],
    to: S.DRIVER_EN_ROUTE,
    actor: { role: 'driver', id: driverId },
    filter: { driverId },
  });
  notifyDriverHire('DRIVER_EN_ROUTE', { booking });
  return asDriver(booking);
};

const parsePosition = (payload) => {
  const latitude = Number(payload?.latitude ?? payload?.lat);
  const longitude = Number(payload?.longitude ?? payload?.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_LOCATION, 'latitude and longitude are required.');
  }
  return { latitude, longitude };
};

/** POST /driver-bookings/{id}/arrived — only from within reach of the pickup pin. */
export const markArrived = async ({ driverId, bookingId, payload }) => {
  const current = await requireAssigned({ driverId, bookingId });
  const position = parsePosition(payload);
  const distance = distanceMeters(position, current.pickup);
  const radius = driverHireConfig().arrivalRadiusMeters;
  if (distance > radius) {
    throw driverHireError(
      422,
      DRIVER_HIRE_ERRORS.INVALID_LOCATION,
      `You are about ${Math.round(distance)} m from the pickup. Mark arrived when you are within ${radius} m.`,
      { distanceMeters: Math.round(distance) },
    );
  }
  const booking = await transition({
    bookingId,
    from: [S.DRIVER_EN_ROUTE],
    to: S.DRIVER_ARRIVED,
    actor: { role: 'driver', id: driverId },
    filter: { driverId },
    set: { driverLocation: { ...position, at: new Date() } },
  });
  notifyDriverHire('DRIVER_ARRIVED', { booking });
  return asDriver(booking);
};

/**
 * POST /driver-bookings/{id}/start — needs the customer's say-so: either the
 * start code they read out, or their in-app arrival confirmation.
 */
export const startTrip = async ({ driverId, bookingId, payload }) => {
  const current = await requireAssigned({ driverId, bookingId, withOtp: true });
  if (current.status !== S.DRIVER_ARRIVED) {
    throw driverHireError(409, DRIVER_HIRE_ERRORS.INVALID_TRANSITION, 'Mark arrived before starting the trip.', { status: current.status });
  }

  const submitted = String(payload?.otp ?? payload?.startCode ?? '').trim();
  const set = {};

  if (submitted) {
    const max = driverHireConfig().otpMaxAttempts;
    const attempts = current.startOtp?.attempts || 0;
    if (attempts >= max) {
      throw driverHireError(429, DRIVER_HIRE_ERRORS.OTP_ATTEMPTS_EXCEEDED, 'Too many wrong codes. Ask the customer to confirm your arrival in their app.');
    }
    if (!codesMatch(decryptField(current.startOtp?.code), submitted)) {
      await DriverHireBooking.updateOne({ _id: current._id, status: S.DRIVER_ARRIVED }, { $inc: { 'startOtp.attempts': 1 } });
      throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_OTP, 'That start code is not right.', { attemptsRemaining: Math.max(0, max - attempts - 1) });
    }
    set['startOtp.verifiedAt'] = new Date();
  } else if (!current.customerConfirmedArrivalAt) {
    throw driverHireError(
      422,
      DRIVER_HIRE_ERRORS.START_NOT_CONFIRMED,
      'Enter the customer\'s start code, or ask them to confirm your arrival in their app.',
    );
  }

  const booking = await transition({
    bookingId,
    from: [S.DRIVER_ARRIVED],
    to: S.TRIP_STARTED,
    actor: { role: 'driver', id: driverId },
    filter: { driverId },
    set,
    auditSummary: { via: submitted ? 'otp' : 'customer_confirmation' },
  });
  notifyDriverHire('TRIP_STARTED', { booking });
  return asDriver(booking);
};

const parseExpenses = (raw, allowed) => {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) return [];
  if (!allowed) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_EXPENSE, 'Expenses cannot be added to this booking; the customer pays tolls and parking directly.');
  }
  if (list.length > 20) throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_EXPENSE, 'At most 20 expenses.');
  return list.map((entry, index) => {
    const kind = String(entry?.kind || '').toUpperCase();
    const amount = roundMoney(entry?.amount);
    if (!['TOLL', 'PARKING', 'OTHER'].includes(kind) || !(amount > 0) || amount > 100000) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_EXPENSE, `expenses[${index}] needs kind TOLL, PARKING or OTHER and an amount above 0.`);
    }
    return { kind, amount, note: String(entry?.note || '').trim().slice(0, 200) };
  });
};

/** The final fare from the booking's frozen terms and what actually happened. */
export const computeFinalFare = (booking, { now = new Date(), expenses = [] } = {}) => {
  const terms = booking.fare.terms;
  const actualMinutes = Math.max(1, Math.ceil((now.getTime() - new Date(booking.startedAt).getTime()) / 60000));
  const waitingMinutes = booking.arrivedAt
    ? Math.max(0, Math.floor((new Date(booking.startedAt).getTime() - new Date(booking.arrivedAt).getTime()) / 60000))
    : 0;
  const billedMinutes = Math.max(booking.durationMinutes, actualMinutes);
  const nights = booking.serviceType === DRIVER_HIRE_SERVICE_TYPES.OUTSTATION
    ? Math.max(booking.nights || 0, Math.ceil(actualMinutes / (24 * 60)) - 1)
    : 0;

  const fare = buildFare(terms, {
    serviceType: booking.serviceType,
    durationMinutes: billedMinutes,
    bookedMinutes: booking.durationMinutes,
    isFinal: true,
    nights,
    outstationTripType: booking.outstationTripType,
    eventPackage: terms.eventPackage,
    scheduledAt: booking.scheduledAt,
    waitingMinutes,
    expenses,
  });

  return { actualMinutes, waitingMinutes, expenses, ...fare };
};

export const completeTrip = async ({ driverId, bookingId, payload }) => {
  const current = await requireAssigned({ driverId, bookingId });
  if (current.status !== S.TRIP_STARTED) {
    throw driverHireError(409, DRIVER_HIRE_ERRORS.INVALID_TRANSITION, 'Only a started trip can be completed.', { status: current.status });
  }
  const expenses = parseExpenses(payload?.expenses, current.fare.terms?.allowDriverExpenses);
  const final = computeFinalFare(current, { expenses });
  const cashCollected = payload?.cashCollected === true || payload?.cash_collected === true;

  const booking = await runInTransaction(async (session) => {
    const updated = await transition({
      bookingId,
      from: [S.TRIP_STARTED],
      to: S.TRIP_COMPLETED,
      actor: { role: 'driver', id: driverId },
      filter: { driverId },
      session,
      set: { final, driverLocation: CLEARED_LOCATION },
      auditSummary: { total: final.total, actualMinutes: final.actualMinutes, expenses: expenses.length },
    });
    await recordTripPayment({ booking: updated, cashCollected, session });
    return updated;
  });

  notifyDriverHire('TRIP_COMPLETED', { booking });
  return asDriver(booking);
};

/** The driver steps away before the trip starts. See releaseDriver. */
export const cancelByDriver = async ({ driverId, bookingId, reason }) => {
  const booking = await releaseDriver({
    bookingId,
    actor: { role: 'driver', id: driverId },
    reason,
    expectedDriverId: driverId,
  });
  return { id: String(booking._id), status: booking.status };
};

/**
 * The customer never appeared. Allowed once the driver has waited the
 * no-show time at the pickup; the no-show fee applies.
 */
export const reportNoShow = async ({ driverId, bookingId }) => {
  const current = await requireAssigned({ driverId, bookingId });
  const waitMinutes = current.fare.terms?.noShowWaitMinutes || 30;
  const readyAt = new Date(new Date(current.arrivedAt || Date.now()).getTime() + waitMinutes * 60000);
  if (current.status === S.DRIVER_ARRIVED && readyAt > new Date()) {
    throw driverHireError(409, DRIVER_HIRE_ERRORS.INVALID_TRANSITION, `Wait until ${readyAt.toISOString()} before reporting a no-show.`, { availableAt: readyAt });
  }
  const fee = roundMoney(current.fare.terms?.noShowFee || 0);

  const booking = await runInTransaction(async (session) => {
    const updated = await transition({
      bookingId,
      from: [S.DRIVER_ARRIVED],
      to: S.CANCELLED_BY_CUSTOMER,
      actor: { role: 'driver', id: driverId },
      note: 'Customer did not show up',
      session,
      filter: { driverId, arrivedAt: { $lte: new Date(Date.now() - waitMinutes * 60000) } },
      set: {
        'cancellation.reason': 'Customer did not show up',
        'cancellation.fee': fee,
        'cancellation.noShow': true,
        'cancellation.actorId': driverId,
        driverLocation: CLEARED_LOCATION,
      },
      auditSummary: { noShow: true, fee },
    });
    await recordCancellationFee({ booking: updated, fee, session });
    return updated;
  });

  return asDriver(booking);
};

/** Location only while it matters: on the way, waiting, or driving. */
export const updateLocation = async ({ driverId, bookingId, payload }) => {
  const position = parsePosition(payload);
  const result = await DriverHireBooking.updateOne(
    { _id: bookingId, driverId, status: { $in: [S.DRIVER_EN_ROUTE, S.DRIVER_ARRIVED, S.TRIP_STARTED] } },
    { $set: { driverLocation: { ...position, at: new Date() } } },
  );
  if (!result.matchedCount) {
    throw driverHireError(409, DRIVER_HIRE_ERRORS.INVALID_TRANSITION, 'Location is only shared during an active trip.');
  }
  return { updated: true };
};

/** Driver dashboard: earnings and counts. */
export const getEarnings = async ({ driverId }) => {
  const profile = await requireProfile(driverId);
  const now = new Date();
  const startOfWeek = new Date(now.getTime() - 7 * 86400000);
  const startOfMonth = new Date(now.getTime() - 30 * 86400000);

  const [totals] = await DriverHirePayment.aggregate([
    { $match: { driverId: profile.driverId } },
    {
      $group: {
        _id: null,
        total: { $sum: '$driverAmount' },
        week: { $sum: { $cond: [{ $gte: ['$createdAt', startOfWeek] }, '$driverAmount', 0] } },
        month: { $sum: { $cond: [{ $gte: ['$createdAt', startOfMonth] }, '$driverAmount', 0] } },
        pendingPayout: { $sum: { $cond: [{ $eq: ['$payoutStatus', 'PENDING'] }, '$driverAmount', 0] } },
      },
    },
  ]);
  const completed = await DriverHireBooking.countDocuments({ driverId, status: S.TRIP_COMPLETED });

  return {
    completedBookings: completed,
    earnings: {
      last7Days: roundMoney(totals?.week || 0),
      last30Days: roundMoney(totals?.month || 0),
      allTime: roundMoney(totals?.total || 0),
      pendingPayout: roundMoney(totals?.pendingPayout || 0),
    },
    rating: profile.ratingAverage || 0,
    ratingCount: profile.ratingCount || 0,
    cancellationsAfterAccept: profile.cancellationsAfterAccept || 0,
  };
};
