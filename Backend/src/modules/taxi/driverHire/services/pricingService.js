import {
  DRIVER_HIRE_ERRORS,
  DRIVER_HIRE_OUTSTATION_TRIP,
  DRIVER_HIRE_SERVICE_TYPES,
  DRIVER_HIRE_STATUS,
} from '../constants/index.js';
import { DriverHirePricing } from '../models/DriverHirePricing.js';
import { audit, driverHireError, isObjectId, localClock, roundMoney, runInTransaction, toObjectIdOrNull } from './common.js';

/**
 * Fares for Search a Driver (spec §7). All arithmetic happens here, on the
 * server, from a frozen copy of the rules (`terms`). A quote and a final fare
 * run the same `buildFare`, so the receipt can only differ from the estimate in
 * the ways the terms say it may: overtime, waiting, extra nights, expenses.
 */

const MONEY_FIELDS = [
  'baseFare', 'extraBlockFare', 'waitingPerMinute', 'nightCharge', 'dailyAllowance',
  'overnightAllowance', 'oneWayReturnFare', 'bookingFee', 'cancellationFee',
  'lateCancellationFee', 'noShowFee',
];
const MINUTE_FIELDS = [
  'includedMinutes', 'minimumMinutes', 'extraBlockMinutes', 'freeWaitingMinutes',
  'freeCancelMinutes', 'freeCancelBeforePickupMinutes', 'noShowWaitMinutes',
];
const OTHER_FIELDS = ['nightStartHour', 'nightEndHour', 'taxPercent', 'platformCommissionPercent', 'allowDriverExpenses', 'currency'];

/** The rules a customer agrees to, copied onto the quote and the booking. */
export const termsFromPricing = (pricing) => {
  const terms = {};
  for (const field of [...MONEY_FIELDS, ...MINUTE_FIELDS, ...OTHER_FIELDS]) {
    terms[field] = pricing[field];
  }
  terms.serviceType = pricing.serviceType;
  terms.eventPackages = (pricing.eventPackages || []).map(({ code, name, minutes, price }) => ({ code, name, minutes, price }));
  return terms;
};

const isNightPickup = (terms, at) => {
  const { minutes } = localClock(at);
  const hour = Math.floor(minutes / 60);
  const { nightStartHour: start, nightEndHour: end } = terms;
  if (start === end) return false;
  return start > end ? (hour >= start || hour < end) : (hour >= start && hour < end);
};

const EXPENSE_LABELS = { TOLL: 'Toll', PARKING: 'Parking', OTHER: 'Expense' };

const line = (code, label, amount, passThrough = false) => ({ code, label, amount: roundMoney(amount), passThrough });

/**
 * Price a trip from frozen terms. `trip.durationMinutes` is what is billed for:
 * the booked duration for a quote, max(booked, actual) for a final fare.
 */
export const buildFare = (terms, trip) => {
  const lines = [];
  const { serviceType } = terms;

  if (serviceType === DRIVER_HIRE_SERVICE_TYPES.EVENT) {
    const pkg = trip.eventPackage;
    lines.push(line('EVENT_PACKAGE', `${pkg.name} (${pkg.minutes} min)`, pkg.price));
    const over = Math.max(0, trip.durationMinutes - pkg.minutes);
    const blocks = Math.ceil(over / terms.extraBlockMinutes);
    if (blocks > 0) {
      lines.push(line('OVERTIME', `Overtime (${blocks} × ${terms.extraBlockMinutes} min)`, blocks * terms.extraBlockFare));
    }
  } else {
    const billable = Math.max(trip.durationMinutes, terms.minimumMinutes);
    lines.push(line('BASE', `Base fare (first ${terms.includedMinutes} min)`, terms.baseFare));
    const over = Math.max(0, billable - terms.includedMinutes);
    const blocks = Math.ceil(over / terms.extraBlockMinutes);
    if (blocks > 0) {
      const code = trip.isFinal && trip.durationMinutes > trip.bookedMinutes ? 'OVERTIME' : 'EXTRA_TIME';
      lines.push(line(code, `Additional time (${blocks} × ${terms.extraBlockMinutes} min)`, blocks * terms.extraBlockFare));
    }
  }

  if (serviceType === DRIVER_HIRE_SERVICE_TYPES.OUTSTATION) {
    const days = Math.max(1, Math.ceil(trip.durationMinutes / (24 * 60)));
    if (terms.dailyAllowance > 0) {
      lines.push(line('DAILY_ALLOWANCE', `Driver allowance (${days} day${days > 1 ? 's' : ''})`, days * terms.dailyAllowance));
    }
    if (trip.nights > 0 && terms.overnightAllowance > 0) {
      lines.push(line('OVERNIGHT', `Overnight stay (${trip.nights} night${trip.nights > 1 ? 's' : ''})`, trip.nights * terms.overnightAllowance));
    }
    if (trip.outstationTripType === DRIVER_HIRE_OUTSTATION_TRIP.ONE_WAY && terms.oneWayReturnFare > 0) {
      lines.push(line('RETURN_TRAVEL', 'Driver return travel (one-way trip)', terms.oneWayReturnFare));
    }
  }

  if (terms.nightCharge > 0 && isNightPickup(terms, trip.scheduledAt)) {
    lines.push(line('NIGHT', 'Night pickup charge', terms.nightCharge));
  }

  const waitingCharged = Math.max(0, Math.ceil((trip.waitingMinutes || 0) - terms.freeWaitingMinutes));
  if (waitingCharged > 0 && terms.waitingPerMinute > 0) {
    lines.push(line('WAITING', `Waiting (${waitingCharged} min beyond ${terms.freeWaitingMinutes} free)`, waitingCharged * terms.waitingPerMinute));
  }

  const fareAmount = lines.reduce((sum, entry) => sum + entry.amount, 0);
  const commission = roundMoney((fareAmount * terms.platformCommissionPercent) / 100);

  if (terms.bookingFee > 0) {
    lines.push(line('BOOKING_FEE', 'Booking fee', terms.bookingFee));
  }

  const taxable = roundMoney(fareAmount + (terms.bookingFee || 0));
  const tax = roundMoney((taxable * terms.taxPercent) / 100);

  const expenses = (trip.expenses || []).map((expense) => {
    const label = EXPENSE_LABELS[expense.kind] || 'Expense';
    return line(`EXPENSE_${expense.kind}`, expense.note ? `${label}: ${expense.note}` : label, expense.amount, true);
  });
  lines.push(...expenses);
  const passThrough = expenses.reduce((sum, entry) => sum + entry.amount, 0);

  return {
    lines,
    subtotal: roundMoney(taxable + passThrough),
    tax,
    total: roundMoney(taxable + tax + passThrough),
    platformFee: roundMoney(commission + (terms.bookingFee || 0)),
    driverAmount: roundMoney(fareAmount - commission + passThrough),
  };
};

/**
 * Cancellation fee if the customer cancelled now (spec §7: shown before
 * confirmation, applied consistently). Free before a driver is assigned, in the
 * grace window after assignment, and while pickup is still comfortably ahead.
 */
export const cancellationFeeFor = (booking, now = new Date()) => {
  const terms = booking.fare?.terms || {};
  const pickupIn = (new Date(booking.scheduledAt).getTime() - now.getTime()) / 60000;

  switch (booking.status) {
    case DRIVER_HIRE_STATUS.REQUESTED:
      return 0;
    case DRIVER_HIRE_STATUS.DRIVER_ASSIGNED: {
      const sinceAssigned = (now.getTime() - new Date(booking.assignedAt || now).getTime()) / 60000;
      if (sinceAssigned <= (terms.freeCancelMinutes ?? 0)) return 0;
      if (pickupIn > (terms.freeCancelBeforePickupMinutes ?? 0)) return 0;
      return roundMoney(terms.cancellationFee || 0);
    }
    case DRIVER_HIRE_STATUS.DRIVER_EN_ROUTE:
    case DRIVER_HIRE_STATUS.DRIVER_ARRIVED:
      return roundMoney(terms.lateCancellationFee || 0);
    default:
      return 0;
  }
};

// ── Rules lookup and admin management ───────────────────────────────────────

/** The current rules for an area, falling back to the default (null area). */
export const getCurrentPricing = async ({ serviceLocationId = null, serviceType }) => {
  const areaId = toObjectIdOrNull(serviceLocationId);
  const candidates = await DriverHirePricing.find({
    serviceType,
    current: true,
    serviceLocationId: { $in: areaId ? [areaId, null] : [null] },
  }).lean();

  const pricing = candidates.find((rule) => areaId && String(rule.serviceLocationId) === String(areaId))
    || candidates.find((rule) => !rule.serviceLocationId);

  if (!pricing || !pricing.active) {
    throw driverHireError(
      422,
      DRIVER_HIRE_ERRORS.PRICING_NOT_CONFIGURED,
      'Search a Driver is not available for this service type here yet.',
    );
  }

  return pricing;
};

/**
 * Customer: the event packages on offer for an area, so the app can list them
 * before quoting. Empty (not an error) when event pricing is not set up there.
 */
export const listEventPackages = async ({ serviceLocationId = null } = {}) => {
  try {
    const pricing = await getCurrentPricing({ serviceLocationId, serviceType: DRIVER_HIRE_SERVICE_TYPES.EVENT });
    return (pricing.eventPackages || []).map((pkg) => ({
      code: pkg.code,
      name: pkg.name,
      minutes: pkg.minutes,
      price: pkg.price,
      currency: pricing.currency || 'INR',
    }));
  } catch (error) {
    if (error?.code === DRIVER_HIRE_ERRORS.PRICING_NOT_CONFIGURED) return [];
    throw error;
  }
};

const numberIn = (value, { min = 0, max = Infinity, field }) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_PRICING, `${field} must be a number between ${min} and ${max}.`);
  }
  return number;
};

const parsePricingPayload = (payload, previous) => {
  const base = previous ? termsFromPricing(previous) : {};
  const rules = { ...base };

  for (const field of MONEY_FIELDS) {
    if (payload[field] !== undefined) rules[field] = roundMoney(numberIn(payload[field], { field, max: 10000000 }));
  }
  for (const field of MINUTE_FIELDS) {
    if (payload[field] !== undefined) rules[field] = Math.round(numberIn(payload[field], { field, max: 100000 }));
  }
  if (payload.nightStartHour !== undefined) rules.nightStartHour = Math.round(numberIn(payload.nightStartHour, { field: 'nightStartHour', max: 23 }));
  if (payload.nightEndHour !== undefined) rules.nightEndHour = Math.round(numberIn(payload.nightEndHour, { field: 'nightEndHour', max: 23 }));
  if (payload.taxPercent !== undefined) rules.taxPercent = numberIn(payload.taxPercent, { field: 'taxPercent', max: 50 });
  if (payload.platformCommissionPercent !== undefined) {
    rules.platformCommissionPercent = numberIn(payload.platformCommissionPercent, { field: 'platformCommissionPercent', max: 100 });
  }
  if (payload.allowDriverExpenses !== undefined) rules.allowDriverExpenses = Boolean(payload.allowDriverExpenses);
  if (payload.currency !== undefined) rules.currency = String(payload.currency || 'INR').trim().toUpperCase().slice(0, 3);

  if (payload.eventPackages !== undefined) {
    if (!Array.isArray(payload.eventPackages)) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_PRICING, 'eventPackages must be a list.');
    }
    const seen = new Set();
    rules.eventPackages = payload.eventPackages.map((pkg, index) => {
      const code = String(pkg?.code || '').trim().toUpperCase();
      const name = String(pkg?.name || '').trim();
      if (!code || !name || seen.has(code)) {
        throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_PRICING, `Event package ${index + 1} needs a unique code and a name.`);
      }
      seen.add(code);
      return {
        code,
        name,
        minutes: Math.round(numberIn(pkg.minutes, { field: `eventPackages[${index}].minutes`, min: 30, max: 24 * 60 })),
        price: roundMoney(numberIn(pkg.price, { field: `eventPackages[${index}].price`, max: 10000000 })),
      };
    });
  }

  if ((rules.extraBlockMinutes ?? 60) < 1) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_PRICING, 'extraBlockMinutes must be at least 1.');
  }

  return rules;
};

/**
 * Admin: publish a new version of the rules for an area and service type. The
 * previous version stays, marked not-current, for every booking that used it.
 */
export const publishPricing = async ({ adminId, payload }) => {
  const serviceType = String(payload?.serviceType || '').toUpperCase();
  if (!Object.values(DRIVER_HIRE_SERVICE_TYPES).includes(serviceType)) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_SERVICE_TYPE, 'serviceType is not valid.');
  }
  const rawArea = payload?.serviceLocationId;
  if (rawArea && !isObjectId(rawArea)) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_PRICING, 'serviceLocationId is not valid.');
  }
  const serviceLocationId = toObjectIdOrNull(rawArea);

  const created = await runInTransaction(async (session) => {
    const previous = await DriverHirePricing.findOne({ serviceLocationId, serviceType, current: true }).session(session);
    const rules = parsePricingPayload(payload, previous);

    if (serviceType === DRIVER_HIRE_SERVICE_TYPES.EVENT && !(rules.eventPackages || []).length) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_PRICING, 'Event pricing needs at least one package.');
    }

    if (previous) {
      previous.current = false;
      await previous.save({ session });
    }

    const [doc] = await DriverHirePricing.create([{
      ...rules,
      serviceType,
      serviceLocationId,
      version: (previous?.version || 0) + 1,
      current: true,
      active: payload.active === undefined ? true : Boolean(payload.active),
      notes: String(payload.notes || '').slice(0, 500),
      createdBy: adminId,
    }], { session });

    await audit({
      actorRole: 'admin',
      actorId: adminId,
      action: 'PRICING_PUBLISHED',
      entityType: 'DriverHirePricing',
      entityId: doc._id,
      changeSummary: { serviceType, serviceLocationId, version: doc.version, previousVersion: previous?.version || null, rules },
      session,
    });

    return doc;
  });

  return created.toObject();
};

export const listPricing = async ({ includeHistory = false } = {}) => DriverHirePricing
  .find(includeHistory ? {} : { current: true })
  .sort({ serviceLocationId: 1, serviceType: 1, version: -1 })
  .lean();
