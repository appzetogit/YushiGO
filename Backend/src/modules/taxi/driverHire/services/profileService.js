import { uploadDataUrlToCloudinary, uploadRawFileToCloudinary } from '../../../../utils/cloudinaryUpload.js';
import { decryptField, encryptField } from '../../../../utils/fieldCrypto.js';
import { Driver } from '../../driver/models/Driver.js';
import {
  DRIVER_HIRE_ACTIVE_STATUSES,
  DRIVER_HIRE_AGREEMENT_VERSION,
  DRIVER_HIRE_ERRORS,
  DRIVER_HIRE_PROFILE_STATUS,
  DRIVER_HIRE_SERVICE_TYPES,
  DRIVER_HIRE_TRANSMISSIONS,
} from '../constants/index.js';
import { DriverHireBooking } from '../models/DriverHireBooking.js';
import { DriverHireProfile } from '../models/DriverHireProfile.js';
import { audit, driverHireError, isObjectId, localClock, toObjectIdOrNull } from './common.js';
import { notifyDriverHire } from './notifications.js';

/**
 * Driver onboarding and eligibility for Search a Driver (spec §3).
 *
 * The driver already has a taxi Driver account (phone verified at sign-up);
 * this adds the licence, capabilities and agreement an admin reviews before the
 * driver can take a booking.
 */

/**
 * The driver agreement, summarised. The binding text is owned by legal and
 * lives outside the code; bump DRIVER_HIRE_AGREEMENT_VERSION when it changes.
 */
export const DRIVER_AGREEMENT = Object.freeze({
  version: DRIVER_HIRE_AGREEMENT_VERSION,
  points: [
    'You drive the customer\'s own car. Yushi Go does not supply a vehicle.',
    'Accept only cars you hold the right licence for and are comfortable driving. Decline if you are unfit to drive.',
    'Your earnings for each booking are shown before you accept. The platform fee is deducted as shown on each receipt.',
    'Cancelling after you accept affects your standing; repeated cancellations can lead to suspension.',
    'Treat customers and their vehicles with care. Report damage, accidents, harassment or unsafe requests through Report a problem straight away.',
    'Keep your licence valid. A licence that expires stops new bookings until a valid one is approved.',
  ],
});

const BUSY_BUFFER_MINUTES = 30;
const MAX_DOC_BYTES = 8 * 1024 * 1024;
const IMAGE = /^data:image\/(jpeg|jpg|png|webp);base64,/i;
const PDF = /^data:application\/pdf;base64,/i;

const startOfToday = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

const licenceValidOn = (profile, at) => Boolean(profile?.licenceExpiry)
  && new Date(profile.licenceExpiry).getTime() >= new Date(at).getTime();

export const serializeProfile = (profile, { forAdmin = false } = {}) => {
  if (!profile) return null;
  return {
    id: String(profile._id),
    driverId: String(profile.driverId?._id || profile.driverId),
    verificationStatus: profile.verificationStatus,
    licenceNumberLast4: profile.licenceNumberLast4 || '',
    licenceExpiry: profile.licenceExpiry || null,
    licenceExpired: Boolean(profile.licenceExpiry) && !licenceValidOn(profile, startOfToday()),
    licenceDocumentUrl: profile.licenceDocumentUrl || '',
    transmissions: profile.transmissions || [],
    serviceTypes: profile.serviceTypes || [],
    serviceLocationIds: (profile.serviceLocationIds || []).map(String),
    experienceYears: profile.experienceYears || 0,
    availabilitySlots: profile.availabilitySlots || [],
    isOnline: Boolean(profile.isOnline),
    agreementVersion: profile.agreementVersion || '',
    agreementCurrent: profile.agreementVersion === DRIVER_HIRE_AGREEMENT_VERSION,
    submittedAt: profile.submittedAt || null,
    reviewedAt: profile.reviewedAt || null,
    reviewNote: profile.reviewNote || '',
    rating: profile.ratingAverage || 0,
    ratingCount: profile.ratingCount || 0,
    ...(forAdmin && profile.driverId?.name !== undefined ? {
      driver: {
        id: String(profile.driverId._id),
        name: profile.driverId.name || '',
        phone: profile.driverId.phone || '',
        rating: profile.driverId.rating || 0,
        profileImage: profile.driverId.profileImage || profile.driverId.profile_picture || '',
      },
    } : {}),
  };
};

const storeLicenceDocument = async ({ driverId, file }) => {
  const dataUrl = String(file || '');
  if (!IMAGE.test(dataUrl) && !PDF.test(dataUrl)) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_DOCUMENT, 'licenceDocument must be a JPEG, PNG, WebP or PDF data URL.');
  }
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (Math.floor((base64.length * 3) / 4) > MAX_DOC_BYTES) {
    throw driverHireError(413, DRIVER_HIRE_ERRORS.INVALID_DOCUMENT, 'Documents must be 8 MB or smaller.');
  }
  const upload = PDF.test(dataUrl) ? uploadRawFileToCloudinary : uploadDataUrlToCloudinary;
  const stored = await upload({
    dataUrl,
    folder: 'driver-hire-documents',
    publicIdPrefix: 'driver-hire-licence',
    publicIdSuffix: String(driverId),
  });
  return stored.secureUrl;
};

const listOf = (value, allowed, field) => {
  const list = Array.isArray(value) ? value : [];
  const normalised = [...new Set(list.map((entry) => String(entry || '').toUpperCase()))];
  const bad = normalised.filter((entry) => !allowed.includes(entry));
  if (bad.length) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.PROFILE_INCOMPLETE, `${field} has unknown values: ${bad.join(', ')}.`);
  }
  return normalised;
};

const parseSlots = (value) => {
  if (!Array.isArray(value)) return [];
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  return value.map((slot, index) => {
    const dayOfWeek = Number(slot?.dayOfWeek);
    const from = String(slot?.from || '');
    const to = String(slot?.to || '');
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6 || !time.test(from) || !time.test(to) || from === to) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.PROFILE_INCOMPLETE, `availabilitySlots[${index}] needs dayOfWeek 0–6 and from/to as HH:mm.`);
    }
    return { dayOfWeek, from, to };
  });
};

export const getMyProfile = async ({ driverId }) => {
  const profile = await DriverHireProfile.findOne({ driverId }).lean();
  return { profile: serializeProfile(profile), agreement: DRIVER_AGREEMENT };
};

/**
 * Driver: create or update their profile. Changing the licence sends an
 * approved profile back for review; other changes (areas, slots, services)
 * take effect straight away.
 */
export const submitProfile = async ({ driverId, payload }) => {
  const existing = await DriverHireProfile.findOne({ driverId });
  const profile = existing || new DriverHireProfile({ driverId });
  let licenceChanged = false;

  const licenceNumber = String(payload?.licenceNumber ?? payload?.licence_number ?? '').replace(/\s+/g, '').toUpperCase();
  if (licenceNumber) {
    if (!/^[A-Z0-9-]{6,20}$/.test(licenceNumber)) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.PROFILE_INCOMPLETE, 'licenceNumber must be 6–20 letters or digits.');
    }
    if (decryptField(profile.licenceNumberEncrypted) !== licenceNumber) {
      profile.licenceNumberEncrypted = encryptField(licenceNumber);
      profile.licenceNumberLast4 = licenceNumber.slice(-4);
      licenceChanged = true;
    }
  }

  const rawExpiry = payload?.licenceExpiry ?? payload?.licence_expiry;
  if (rawExpiry) {
    const expiry = new Date(rawExpiry);
    if (Number.isNaN(expiry.getTime())) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.PROFILE_INCOMPLETE, 'licenceExpiry must be a date.');
    }
    if (expiry.getTime() < startOfToday().getTime()) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.PROFILE_INCOMPLETE, 'This licence has expired. Upload a valid licence.');
    }
    if (!profile.licenceExpiry || expiry.getTime() !== new Date(profile.licenceExpiry).getTime()) {
      profile.licenceExpiry = expiry;
      profile.licenceRemindersSent = [];
      licenceChanged = true;
    }
  }

  const file = payload?.licenceDocument ?? payload?.licence_document;
  if (file) {
    profile.licenceDocumentUrl = await storeLicenceDocument({ driverId, file });
    licenceChanged = true;
  }

  if (payload?.transmissions !== undefined) {
    profile.transmissions = listOf(payload.transmissions, Object.values(DRIVER_HIRE_TRANSMISSIONS), 'transmissions');
  }
  if (payload?.serviceTypes !== undefined) {
    profile.serviceTypes = listOf(payload.serviceTypes, Object.values(DRIVER_HIRE_SERVICE_TYPES), 'serviceTypes');
  }
  if (payload?.serviceLocationIds !== undefined) {
    const ids = Array.isArray(payload.serviceLocationIds) ? payload.serviceLocationIds : [];
    if (ids.some((id) => !isObjectId(id))) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.PROFILE_INCOMPLETE, 'serviceLocationIds must be service location ids.');
    }
    profile.serviceLocationIds = [...new Set(ids.map(String))].map(toObjectIdOrNull);
  }
  if (payload?.experienceYears !== undefined) {
    const years = Number(payload.experienceYears);
    if (!Number.isFinite(years) || years < 0 || years > 60) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.PROFILE_INCOMPLETE, 'experienceYears must be between 0 and 60.');
    }
    profile.experienceYears = Math.floor(years);
  }
  if (payload?.availabilitySlots !== undefined) {
    profile.availabilitySlots = parseSlots(payload.availabilitySlots);
  }

  const accept = payload?.acceptAgreement ?? payload?.accept_agreement;
  if (accept === true) {
    profile.agreementVersion = DRIVER_HIRE_AGREEMENT_VERSION;
    profile.agreementAcceptedAt = new Date();
  }

  const missing = [];
  if (!profile.licenceNumberEncrypted) missing.push('licenceNumber');
  if (!profile.licenceExpiry) missing.push('licenceExpiry');
  if (!profile.licenceDocumentUrl) missing.push('licenceDocument');
  if (!profile.transmissions.length) missing.push('transmissions');
  if (!profile.serviceTypes.length) missing.push('serviceTypes');
  if (missing.length) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.PROFILE_INCOMPLETE, `Missing: ${missing.join(', ')}.`, { missing });
  }
  if (profile.agreementVersion !== DRIVER_HIRE_AGREEMENT_VERSION) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.AGREEMENT_REQUIRED, 'Accept the current driver agreement to continue.');
  }

  const wasApproved = profile.verificationStatus === DRIVER_HIRE_PROFILE_STATUS.APPROVED;
  if (!existing || licenceChanged || profile.verificationStatus === DRIVER_HIRE_PROFILE_STATUS.REJECTED) {
    if (profile.verificationStatus !== DRIVER_HIRE_PROFILE_STATUS.SUSPENDED) {
      profile.verificationStatus = DRIVER_HIRE_PROFILE_STATUS.PENDING;
      profile.submittedAt = new Date();
      profile.isOnline = false;
    }
  }

  await profile.save();

  if (wasApproved && profile.verificationStatus === DRIVER_HIRE_PROFILE_STATUS.PENDING) {
    await audit({ actorRole: 'driver', actorId: driverId, action: 'PROFILE_RESUBMITTED', entityType: 'DriverHireProfile', entityId: profile._id, changeSummary: { reason: 'licence changed' } });
  }

  return { profile: serializeProfile(profile), agreement: DRIVER_AGREEMENT };
};

/** Driver: go online/offline for Search a Driver. Online needs a valid, approved profile. */
export const setOnline = async ({ driverId, online }) => {
  const profile = await DriverHireProfile.findOne({ driverId });
  if (!profile) {
    throw driverHireError(404, DRIVER_HIRE_ERRORS.PROFILE_NOT_FOUND, 'Complete your Search a Driver profile first.');
  }
  if (online) {
    const reason = profileBlocker(profile, startOfToday());
    if (reason) {
      throw driverHireError(403, DRIVER_HIRE_ERRORS.DRIVER_NOT_ELIGIBLE, reason);
    }
  }
  profile.isOnline = Boolean(online);
  await profile.save();
  return serializeProfile(profile);
};

// ── Eligibility ─────────────────────────────────────────────────────────────

/** Why this profile cannot drive at all on `at`, or null. */
const profileBlocker = (profile, at) => {
  if (!profile) return 'No Search a Driver profile.';
  if (profile.verificationStatus !== DRIVER_HIRE_PROFILE_STATUS.APPROVED) return `Profile is ${profile.verificationStatus.toLowerCase()}.`;
  if (profile.agreementVersion !== DRIVER_HIRE_AGREEMENT_VERSION) return 'The current driver agreement has not been accepted.';
  if (!licenceValidOn(profile, at)) return 'Driving licence is expired or expires before this booking ends.';
  return null;
};

const inSlots = (profile, booking) => {
  if (!profile.availabilitySlots?.length) return true;
  const { dayOfWeek, minutes } = localClock(booking.scheduledAt);
  const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  return profile.availabilitySlots.some((slot) => {
    const from = toMinutes(slot.from);
    const to = toMinutes(slot.to);
    if (from < to) return slot.dayOfWeek === dayOfWeek && minutes >= from && minutes < to;
    // Overnight slot (e.g. 22:00–02:00): starts on dayOfWeek, ends the next day.
    return (slot.dayOfWeek === dayOfWeek && minutes >= from) || ((slot.dayOfWeek + 1) % 7 === dayOfWeek && minutes < to);
  });
};

/**
 * Why this driver cannot take this booking, or null. Pure apart from the
 * busy check, which callers run separately (inside their transaction).
 */
export const eligibilityBlocker = (profile, booking, { requireOnline = false, driver = null } = {}) => {
  const base = profileBlocker(profile, booking.windowEndsAt);
  if (base) return base;
  if (driver && (driver.deletedAt || driver.approve === false)) return 'Driver account is not active.';
  if (requireOnline && !profile.isOnline) return 'Driver is offline for Search a Driver.';
  if (!profile.transmissions.includes(booking.vehicle.transmission)) {
    return `Driver does not drive ${booking.vehicle.transmission.toLowerCase()} cars.`;
  }
  if (!profile.serviceTypes.includes(booking.serviceType)) return 'Driver does not offer this service type.';
  if (booking.serviceLocationId && profile.serviceLocationIds?.length
    && !profile.serviceLocationIds.some((id) => String(id) === String(booking.serviceLocationId))) {
    return 'Booking is outside the driver\'s service areas.';
  }
  if ((booking.declinedDriverIds || []).some((id) => String(id) === String(profile.driverId))) {
    return 'Driver already declined this booking.';
  }
  if (!inSlots(profile, booking)) return 'Booking is outside the driver\'s availability.';
  return null;
};

const overlapFilter = (booking) => {
  const buffer = BUSY_BUFFER_MINUTES * 60000;
  return {
    status: { $in: DRIVER_HIRE_ACTIVE_STATUSES },
    scheduledAt: { $lt: new Date(new Date(booking.windowEndsAt).getTime() + buffer) },
    windowEndsAt: { $gt: new Date(new Date(booking.scheduledAt).getTime() - buffer) },
    _id: { $ne: booking._id },
  };
};

/** True if the driver holds another active booking overlapping this one's window. */
export const isDriverBusy = async ({ driverId, booking, session = null }) => {
  const query = DriverHireBooking.exists({ driverId, ...overlapFilter(booking) });
  if (session) query.session(session);
  return Boolean(await query);
};

/**
 * Every driver who could take this booking now. Used for admin assignment and,
 * as a bare count, for the customer's availability check.
 */
export const findEligibleDrivers = async ({ booking, requireOnline = false, limit = 50 }) => {
  const filter = {
    verificationStatus: DRIVER_HIRE_PROFILE_STATUS.APPROVED,
    agreementVersion: DRIVER_HIRE_AGREEMENT_VERSION,
    licenceExpiry: { $gte: booking.windowEndsAt },
    transmissions: booking.vehicle.transmission,
    serviceTypes: booking.serviceType,
  };
  if (requireOnline) filter.isOnline = true;
  if (booking.serviceLocationId) {
    filter.$or = [{ serviceLocationIds: { $size: 0 } }, { serviceLocationIds: booking.serviceLocationId }];
  }
  if (booking.declinedDriverIds?.length) filter.driverId = { $nin: booking.declinedDriverIds };

  const profiles = await DriverHireProfile.find(filter).limit(limit * 3).lean();
  if (!profiles.length) return [];

  const driverIds = profiles.map((profile) => profile.driverId);
  const [drivers, busy] = await Promise.all([
    Driver.find({ _id: { $in: driverIds }, deletedAt: null, approve: { $ne: false } })
      .select('name phone rating profileImage profile_picture')
      .lean(),
    DriverHireBooking.distinct('driverId', { driverId: { $in: driverIds }, ...overlapFilter(booking) }),
  ]);
  const busySet = new Set(busy.map(String));
  const driverMap = new Map(drivers.map((driver) => [String(driver._id), driver]));

  return profiles
    .filter((profile) => driverMap.has(String(profile.driverId)) && !busySet.has(String(profile.driverId)))
    .filter((profile) => !eligibilityBlocker(profile, booking, { requireOnline }))
    .slice(0, limit)
    .map((profile) => ({ profile, driver: driverMap.get(String(profile.driverId)) }));
};

// ── Admin review ────────────────────────────────────────────────────────────

export const adminListProfiles = async ({ status = '', expiringWithinDays = null } = {}) => {
  const filter = {};
  if (status) filter.verificationStatus = String(status).toUpperCase();
  if (expiringWithinDays) {
    filter.licenceExpiry = { $lte: new Date(Date.now() + Number(expiringWithinDays) * 86400000) };
  }
  const profiles = await DriverHireProfile.find(filter)
    .sort({ submittedAt: -1, createdAt: -1 })
    .limit(200)
    .populate('driverId', 'name phone rating profileImage profile_picture')
    .lean();
  return profiles.map((profile) => serializeProfile(profile, { forAdmin: true }));
};

/** Admin: one profile with the full licence number. Viewing it is audited. */
export const adminGetProfile = async ({ adminId, profileId }) => {
  if (!isObjectId(profileId)) throw driverHireError(404, DRIVER_HIRE_ERRORS.PROFILE_NOT_FOUND, 'Profile not found.');
  const profile = await DriverHireProfile.findById(profileId)
    .populate('driverId', 'name phone rating profileImage profile_picture')
    .lean();
  if (!profile) throw driverHireError(404, DRIVER_HIRE_ERRORS.PROFILE_NOT_FOUND, 'Profile not found.');

  await audit({ actorRole: 'admin', actorId: adminId, action: 'PROFILE_VIEWED', entityType: 'DriverHireProfile', entityId: profile._id });

  return {
    ...serializeProfile(profile, { forAdmin: true }),
    licenceNumber: decryptField(profile.licenceNumberEncrypted),
  };
};

const REVIEW_ACTIONS = {
  approve: { to: DRIVER_HIRE_PROFILE_STATUS.APPROVED, from: [DRIVER_HIRE_PROFILE_STATUS.PENDING, DRIVER_HIRE_PROFILE_STATUS.REJECTED], needsReason: false },
  reject: { to: DRIVER_HIRE_PROFILE_STATUS.REJECTED, from: [DRIVER_HIRE_PROFILE_STATUS.PENDING], needsReason: true },
  suspend: { to: DRIVER_HIRE_PROFILE_STATUS.SUSPENDED, from: [DRIVER_HIRE_PROFILE_STATUS.APPROVED, DRIVER_HIRE_PROFILE_STATUS.PENDING], needsReason: true },
  reinstate: { to: DRIVER_HIRE_PROFILE_STATUS.APPROVED, from: [DRIVER_HIRE_PROFILE_STATUS.SUSPENDED], needsReason: false },
};

export const adminReviewProfile = async ({ adminId, profileId, action, reason = '' }) => {
  const rule = REVIEW_ACTIONS[action];
  const note = String(reason || '').trim();
  if (!rule) throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_TRANSITION, 'Unknown review action.');
  if (rule.needsReason && !note) throw driverHireError(422, DRIVER_HIRE_ERRORS.REASON_REQUIRED, 'A reason is required.');
  if (!isObjectId(profileId)) throw driverHireError(404, DRIVER_HIRE_ERRORS.PROFILE_NOT_FOUND, 'Profile not found.');

  const profile = await DriverHireProfile.findById(profileId);
  if (!profile) throw driverHireError(404, DRIVER_HIRE_ERRORS.PROFILE_NOT_FOUND, 'Profile not found.');
  if (!rule.from.includes(profile.verificationStatus)) {
    throw driverHireError(409, DRIVER_HIRE_ERRORS.INVALID_TRANSITION, `Cannot ${action} a ${profile.verificationStatus.toLowerCase()} profile.`);
  }
  if (rule.to === DRIVER_HIRE_PROFILE_STATUS.APPROVED && !licenceValidOn(profile, startOfToday())) {
    throw driverHireError(409, DRIVER_HIRE_ERRORS.DRIVER_NOT_ELIGIBLE, 'The licence on this profile has expired.');
  }

  const from = profile.verificationStatus;
  profile.verificationStatus = rule.to;
  profile.reviewedBy = adminId;
  profile.reviewedAt = new Date();
  profile.reviewNote = note.slice(0, 500);
  if (rule.to !== DRIVER_HIRE_PROFILE_STATUS.APPROVED) profile.isOnline = false;
  await profile.save();

  await audit({
    actorRole: 'admin',
    actorId: adminId,
    action: `PROFILE_${action.toUpperCase()}`,
    entityType: 'DriverHireProfile',
    entityId: profile._id,
    changeSummary: { from, to: rule.to, reason: note },
  });

  notifyDriverHire(`PROFILE_${rule.to}`, { driverId: profile.driverId, reason: note });

  return serializeProfile(profile);
};
