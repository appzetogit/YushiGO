import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { DRIVER_HIRE_ERRORS, driverHireConfig } from '../constants/index.js';
import { DriverHireAuditLog } from '../models/DriverHireRecords.js';

export { runInTransaction } from '../../carpool/services/transaction.js';

export const driverHireError = (status, code, message, details = null) => {
  const error = new ApiError(status, message, details);
  error.code = code;
  return error;
};

/** Read a field the app may send in camelCase or snake_case. */
export const pick = (payload, camel, snake = null) => {
  const source = payload || {};
  if (source[camel] !== undefined) return source[camel];
  const fallback = snake || camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return source[fallback];
};

export const isObjectId = (value) => mongoose.isValidObjectId(value) && String(value).length === 24;

export const toObjectIdOrNull = (value) => (isObjectId(value) ? new mongoose.Types.ObjectId(String(value)) : null);

export const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const randomCode = (length) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');
};

export const newBookingCode = () => `DH${randomCode(8)}`;
export const newCaseCode = () => `DHS${randomCode(7)}`;

export const newOtp = () => Array.from(
  { length: driverHireConfig().otpLength },
  () => crypto.randomInt(0, 10),
).join('');

/** Constant-time string comparison for codes of possibly different lengths. */
export const codesMatch = (a, b) => {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
};

export const parsePlace = (raw, field, { required = true } = {}) => {
  if (raw === undefined || raw === null || raw === '') {
    if (required) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_LOCATION, `${field} is required.`);
    }
    return null;
  }

  const address = String(raw.address ?? raw.name ?? '').trim();
  const latitude = Number(raw.latitude ?? raw.lat);
  const longitude = Number(raw.longitude ?? raw.lng);

  if (!address || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) {
    throw driverHireError(
      422,
      DRIVER_HIRE_ERRORS.INVALID_LOCATION,
      `${field} needs an address, latitude and longitude.`,
    );
  }

  return { address: address.slice(0, 300), latitude, longitude };
};

/** Great-circle distance in metres. */
export const distanceMeters = (a, b) => {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

/** Day of week (0 = Sunday) and minutes past midnight, in the module's timezone. */
export const localClock = (date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: driverHireConfig().timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(date));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return {
    dayOfWeek: days.indexOf(get('weekday')),
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
};

/**
 * Append to the audit trail. Never throws: an audit write failing must not undo
 * the action it describes, but it is logged loudly.
 */
export const audit = async ({ actorRole, actorId = null, action, entityType, entityId, changeSummary = {}, session = null }) => {
  try {
    await DriverHireAuditLog.create(
      [{ actorRole, actorId, action, entityType, entityId, changeSummary }],
      session ? { session } : {},
    );
  } catch (error) {
    if (session) throw error;
    console.error(`[driverHire] audit write failed for ${action}`, error?.message || error);
  }
};
