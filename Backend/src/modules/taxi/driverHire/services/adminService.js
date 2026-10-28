import {
  DRIVER_HIRE_ERRORS,
  DRIVER_HIRE_PROFILE_STATUS,
  DRIVER_HIRE_SERVICE_TYPES,
  DRIVER_HIRE_STATUS,
  DRIVER_HIRE_TERMINAL_STATUSES,
} from '../constants/index.js';
import { DriverHireBooking } from '../models/DriverHireBooking.js';
import { DriverHireProfile } from '../models/DriverHireProfile.js';
import {
  DriverHireAuditLog,
  DriverHirePayment,
  DriverHireReview,
  DriverHireSupportCase,
} from '../models/DriverHireRecords.js';
import { driverHireError, isObjectId, roundMoney, runInTransaction } from './common.js';
import { assignDriver, offerToDriver, releaseDriver } from './lifecycleService.js';
import { notifyDriverHire } from './notifications.js';
import { listPaymentsForBooking, recordCancellationFee, recordRefund } from './paymentService.js';
import { cancellationFeeFor } from './pricingService.js';
import { findEligibleDrivers } from './profileService.js';
import { serializeForAdmin } from './serializers.js';
import { loadBooking, transition } from './stateMachine.js';

/** Operations panel (spec §4): bookings, assignment, disputes, reporting. */

const S = DRIVER_HIRE_STATUS;
const POPULATE = [
  { path: 'customerId', select: 'name phone' },
  { path: 'driverId', select: 'name phone' },
];

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const listBookings = async ({ query = {} }) => {
  const filter = {};
  if (query.status) filter.status = { $in: String(query.status).toUpperCase().split(',') };
  if (query.serviceType) filter.serviceType = String(query.serviceType).toUpperCase();
  if (isObjectId(query.serviceLocationId)) filter.serviceLocationId = query.serviceLocationId;
  if (isObjectId(query.driverId)) filter.driverId = query.driverId;
  if (query.from || query.to) {
    filter.scheduledAt = {};
    if (query.from) filter.scheduledAt.$gte = new Date(query.from);
    if (query.to) filter.scheduledAt.$lte = new Date(query.to);
  }
  if (query.q) filter.bookingCode = { $regex: `^${escapeRegex(String(query.q).trim().toUpperCase())}` };
  // Needs attention: unassigned and due within the hour, or offers left hanging.
  if (query.attention === 'true') {
    filter.status = S.REQUESTED;
    filter.scheduledAt = { $lte: new Date(Date.now() + 60 * 60000) };
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
  const [items, total] = await Promise.all([
    DriverHireBooking.find(filter).sort({ scheduledAt: -1 }).skip((page - 1) * limit).limit(limit).populate(POPULATE),
    DriverHireBooking.countDocuments(filter),
  ]);
  return { items: items.map(serializeForAdmin), total, page, limit };
};

export const getBookingDetail = async ({ bookingId }) => {
  if (!isObjectId(bookingId)) throw driverHireError(404, DRIVER_HIRE_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
  const booking = await DriverHireBooking.findById(bookingId).populate(POPULATE);
  if (!booking) throw driverHireError(404, DRIVER_HIRE_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
  const [payments, reviews, cases, auditTrail] = await Promise.all([
    listPaymentsForBooking(booking._id),
    DriverHireReview.find({ bookingId: booking._id }).lean(),
    DriverHireSupportCase.find({ bookingId: booking._id }).sort({ createdAt: -1 }).lean(),
    DriverHireAuditLog.find({ entityType: 'DriverHireBooking', entityId: booking._id }).sort({ createdAt: 1 }).lean(),
  ]);
  return {
    booking: serializeForAdmin(booking),
    payments,
    reviews,
    supportCases: cases,
    audit: auditTrail,
    cancellationFeeIfCancelledNow: DRIVER_HIRE_TERMINAL_STATUSES.includes(booking.status) ? null : cancellationFeeFor(booking),
  };
};

export const eligibleDrivers = async ({ bookingId }) => {
  const booking = await loadBooking(bookingId);
  const drivers = await findEligibleDrivers({ booking, requireOnline: false, limit: 50 });
  return drivers.map(({ profile, driver }) => ({
    driverId: String(driver._id),
    name: driver.name || '',
    phone: driver.phone || '',
    rating: profile.ratingAverage || 0,
    experienceYears: profile.experienceYears || 0,
    isOnline: Boolean(profile.isOnline),
    transmissions: profile.transmissions,
    licenceExpiry: profile.licenceExpiry,
  }));
};

/**
 * Admin-assisted assignment (spec §9 phase 1). `direct` assigns outright, for a
 * driver who has already agreed by phone; otherwise the driver gets an offer.
 */
export const assignBooking = async ({ adminId, bookingId, payload }) => {
  const driverId = payload?.driverId;
  if (!isObjectId(driverId)) throw driverHireError(422, DRIVER_HIRE_ERRORS.DRIVER_NOT_ELIGIBLE, 'driverId is required.');
  const actor = { role: 'admin', id: adminId };
  const booking = payload?.direct === true
    ? await assignDriver({ bookingId, driverId, actor, requireOnline: false, respectOffer: false })
    : await offerToDriver({ bookingId, driverId, actor });
  return serializeForAdmin(booking);
};

/** Take the driver off and put the booking back in the queue. */
export const reassignBooking = async ({ adminId, bookingId, reason }) => {
  const booking = await releaseDriver({ bookingId, actor: { role: 'admin', id: adminId }, reason, forceReopen: true });
  return serializeForAdmin(booking);
};

export const cancelBooking = async ({ adminId, bookingId, payload }) => {
  const reason = String(payload?.reason || '').trim();
  if (!reason) throw driverHireError(422, DRIVER_HIRE_ERRORS.REASON_REQUIRED, 'A cancellation reason is required.');
  const current = await loadBooking(bookingId);
  // Admin cancellations are free unless ops decide the customer's fee applies.
  const fee = payload?.chargeCustomerFee === true ? cancellationFeeFor(current) : 0;

  const booking = await runInTransaction(async (session) => {
    const updated = await transition({
      bookingId,
      from: [current.status],
      to: S.CANCELLED_BY_ADMIN,
      actor: { role: 'admin', id: adminId },
      note: reason,
      session,
      set: {
        'cancellation.reason': reason.slice(0, 500),
        'cancellation.fee': fee,
        'cancellation.actorId': adminId,
        'offer.driverId': null,
        'offer.expiresAt': null,
        driverLocation: { latitude: null, longitude: null, at: null },
      },
      auditSummary: { from: current.status, reason, fee },
    });
    await recordCancellationFee({ booking: updated, fee, session });
    return updated;
  });

  notifyDriverHire('CANCELLED_BY_ADMIN', { booking });
  return serializeForAdmin(booking);
};

export const openDispute = async ({ adminId, bookingId, note }) => {
  const text = String(note || '').trim();
  if (!text) throw driverHireError(422, DRIVER_HIRE_ERRORS.REASON_REQUIRED, 'Describe the dispute.');
  const booking = await transition({
    bookingId,
    from: [S.TRIP_COMPLETED],
    to: S.DISPUTED,
    actor: { role: 'admin', id: adminId },
    note: text,
    set: { 'dispute.openedAt': new Date(), 'dispute.openedBy': adminId, 'dispute.note': text.slice(0, 500) },
  });
  return serializeForAdmin(booking);
};

/** Close a dispute, optionally refunding part of the trip payment. */
export const resolveDispute = async ({ adminId, bookingId, payload }) => {
  const outcome = String(payload?.outcome || '').trim();
  if (!outcome) throw driverHireError(422, DRIVER_HIRE_ERRORS.REASON_REQUIRED, 'Record the outcome.');
  const refundAmount = roundMoney(payload?.refundAmount || 0);

  const booking = await runInTransaction(async (session) => {
    const updated = await transition({
      bookingId,
      from: [S.DISPUTED],
      to: S.TRIP_COMPLETED,
      event: 'DISPUTE_RESOLVED',
      actor: { role: 'admin', id: adminId },
      note: outcome,
      session,
      set: { 'dispute.resolvedAt': new Date(), 'dispute.resolvedBy': adminId, 'dispute.outcome': outcome.slice(0, 500) },
      auditSummary: { outcome, refundAmount },
    });
    if (refundAmount > 0) {
      const payment = await DriverHirePayment.findOne({ bookingId, kind: 'TRIP' }).session(session);
      if (!payment) throw driverHireError(409, DRIVER_HIRE_ERRORS.INVALID_REFUND, 'There is no trip payment to refund.');
      await recordRefund({ adminId, paymentId: payment, amount: refundAmount, reason: outcome, session });
    }
    return updated;
  });

  return serializeForAdmin(booking);
};

export const listPayments = async ({ query = {} }) => {
  const filter = {};
  if (query.paymentStatus) filter.paymentStatus = String(query.paymentStatus).toUpperCase();
  if (query.payoutStatus) filter.payoutStatus = String(query.payoutStatus).toUpperCase();
  if (query.refundStatus) filter.refundStatus = String(query.refundStatus).toUpperCase();
  return DriverHirePayment.find(filter).sort({ createdAt: -1 }).limit(200).lean();
};

export const listAudit = async ({ query = {} }) => {
  const filter = {};
  if (query.entityType) filter.entityType = String(query.entityType);
  if (isObjectId(query.entityId)) filter.entityId = query.entityId;
  if (query.action) filter.action = String(query.action).toUpperCase();
  return DriverHireAuditLog.find(filter).sort({ createdAt: -1 }).limit(200).lean();
};

/** Reporting (spec §4): bookings by type and status, completion, cancellations, supply, ratings, support. */
export const getReport = async ({ query = {} }) => {
  const match = {};
  const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 86400000);
  const to = query.to ? new Date(query.to) : new Date();
  match.scheduledAt = { $gte: from, $lte: to };
  if (isObjectId(query.serviceLocationId)) match.serviceLocationId = query.serviceLocationId;

  const [byStatusType, revenue, profiles, online, ratings, openCases] = await Promise.all([
    DriverHireBooking.aggregate([
      { $match: match },
      { $group: { _id: { status: '$status', serviceType: '$serviceType' }, count: { $sum: 1 } } },
    ]),
    DriverHireBooking.aggregate([
      { $match: { ...match, status: S.TRIP_COMPLETED } },
      { $group: { _id: null, gross: { $sum: '$final.total' }, platform: { $sum: '$final.platformFee' }, drivers: { $sum: '$final.driverAmount' } } },
    ]),
    DriverHireProfile.aggregate([{ $group: { _id: '$verificationStatus', count: { $sum: 1 } } }]),
    DriverHireProfile.countDocuments({ verificationStatus: DRIVER_HIRE_PROFILE_STATUS.APPROVED, isOnline: true }),
    DriverHireReview.aggregate([
      { $match: { reviewerRole: 'user', createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]),
    DriverHireSupportCase.aggregate([
      { $match: { status: { $in: ['OPEN', 'IN_PROGRESS'] } } },
      { $group: { _id: '$priority', count: { $sum: 1 } } },
    ]),
  ]);

  const byStatus = {};
  const byServiceType = Object.fromEntries(Object.values(DRIVER_HIRE_SERVICE_TYPES).map((type) => [type, 0]));
  for (const row of byStatusType) {
    byStatus[row._id.status] = (byStatus[row._id.status] || 0) + row.count;
    byServiceType[row._id.serviceType] = (byServiceType[row._id.serviceType] || 0) + row.count;
  }
  const completed = byStatus[S.TRIP_COMPLETED] || 0;
  const cancelled = (byStatus[S.CANCELLED_BY_CUSTOMER] || 0) + (byStatus[S.CANCELLED_BY_DRIVER] || 0) + (byStatus[S.CANCELLED_BY_ADMIN] || 0);
  const expired = byStatus[S.EXPIRED] || 0;
  const finished = completed + cancelled + expired;

  return {
    range: { from, to },
    totalBookings: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
    byStatus,
    byServiceType,
    completionRate: finished ? Math.round((completed / finished) * 1000) / 10 : null,
    cancellations: {
      byCustomer: byStatus[S.CANCELLED_BY_CUSTOMER] || 0,
      byDriver: byStatus[S.CANCELLED_BY_DRIVER] || 0,
      byAdmin: byStatus[S.CANCELLED_BY_ADMIN] || 0,
      noDriverFound: expired,
    },
    revenue: {
      gross: roundMoney(revenue[0]?.gross || 0),
      platformFees: roundMoney(revenue[0]?.platform || 0),
      driverEarnings: roundMoney(revenue[0]?.drivers || 0),
    },
    drivers: {
      ...Object.fromEntries(profiles.map((row) => [row._id, row.count])),
      onlineNow: online,
    },
    ratings: { average: ratings[0] ? Math.round(ratings[0].average * 100) / 100 : null, count: ratings[0]?.count || 0 },
    openSupportCases: Object.fromEntries(openCases.map((row) => [row._id, row.count])),
  };
};
