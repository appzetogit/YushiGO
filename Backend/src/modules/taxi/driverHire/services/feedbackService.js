import {
  DRIVER_HIRE_ERRORS,
  DRIVER_HIRE_REVIEW_STATUS,
  DRIVER_HIRE_STATUS,
  DRIVER_HIRE_SUPPORT_CATEGORIES,
  DRIVER_HIRE_SUPPORT_STATUS,
  DRIVER_HIRE_URGENT_CATEGORIES,
} from '../constants/index.js';
import { DriverHireBooking } from '../models/DriverHireBooking.js';
import { DriverHireProfile } from '../models/DriverHireProfile.js';
import { DriverHireReview, DriverHireSupportCase } from '../models/DriverHireRecords.js';
import { audit, driverHireError, isObjectId, newCaseCode, runInTransaction } from './common.js';
import { loadBooking } from './stateMachine.js';

/** Ratings, reviews and support/safety cases (spec §2, §3, §4). */

const partyOf = (booking, role, actorId) => {
  if (role === 'user' && String(booking.customerId) === String(actorId)) return 'customer';
  if (role === 'driver' && String(booking.driverId || '') === String(actorId)) return 'driver';
  return null;
};

/**
 * Rate the other side of a completed booking, once. A customer's rating feeds
 * the driver's Search a Driver average (not their taxi rating).
 */
export const createReview = async ({ role, actorId, bookingId, payload }) => {
  const rating = Number(payload?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_RATING, 'rating must be a whole number from 1 to 5.');
  }
  const comment = String(payload?.comment || '').trim();
  if (comment.length > 1000) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_RATING, 'comment must be 1000 characters or fewer.');
  }

  const booking = await loadBooking(bookingId);
  const party = partyOf(booking, role, actorId);
  if (!party) throw driverHireError(404, DRIVER_HIRE_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
  if (booking.status !== DRIVER_HIRE_STATUS.TRIP_COMPLETED) {
    throw driverHireError(409, DRIVER_HIRE_ERRORS.RATING_NOT_ALLOWED, 'Only completed trips can be rated.');
  }

  const flag = party === 'customer' ? 'customerRated' : 'driverRated';

  const review = await runInTransaction(async (session) => {
    const claimed = await DriverHireBooking.updateOne(
      { _id: booking._id, [flag]: false },
      { $set: { [flag]: true } },
      { session },
    );
    if (!claimed.modifiedCount) {
      throw driverHireError(409, DRIVER_HIRE_ERRORS.DUPLICATE_RATING, 'You have already rated this trip.');
    }

    const [created] = await DriverHireReview.create([{
      bookingId: booking._id,
      reviewerRole: role,
      reviewerId: actorId,
      revieweeId: party === 'customer' ? booking.driverId : booking.customerId,
      rating,
      comment,
    }], { session });

    if (party === 'customer') {
      await DriverHireProfile.updateOne(
        { driverId: booking.driverId },
        [
          { $set: { ratingTotal: { $add: ['$ratingTotal', rating] }, ratingCount: { $add: ['$ratingCount', 1] } } },
          { $set: { ratingAverage: { $round: [{ $divide: ['$ratingTotal', '$ratingCount'] }, 2] } } },
        ],
        { session, updatePipeline: true },
      );
    }
    return created;
  });

  return { id: String(review._id), rating: review.rating, comment: review.comment };
};

/** Admin: hide a review (abusive, personal data). The rating average is recomputed. */
export const adminModerateReview = async ({ adminId, reviewId, status }) => {
  if (!Object.values(DRIVER_HIRE_REVIEW_STATUS).includes(status)) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_RATING, 'status must be PUBLISHED or HIDDEN.');
  }
  if (!isObjectId(reviewId)) throw driverHireError(404, DRIVER_HIRE_ERRORS.INVALID_RATING, 'Review not found.');
  const review = await DriverHireReview.findById(reviewId);
  if (!review) throw driverHireError(404, DRIVER_HIRE_ERRORS.INVALID_RATING, 'Review not found.');
  const from = review.moderationStatus;
  review.moderationStatus = status;
  review.moderatedBy = adminId;
  await review.save();

  if (review.reviewerRole === 'user') {
    const [agg] = await DriverHireReview.aggregate([
      { $match: { revieweeId: review.revieweeId, reviewerRole: 'user', moderationStatus: DRIVER_HIRE_REVIEW_STATUS.PUBLISHED } },
      { $group: { _id: null, total: { $sum: '$rating' }, count: { $sum: 1 } } },
    ]);
    await DriverHireProfile.updateOne({ driverId: review.revieweeId }, {
      $set: {
        ratingTotal: agg?.total || 0,
        ratingCount: agg?.count || 0,
        ratingAverage: agg?.count ? Math.round((agg.total / agg.count) * 100) / 100 : 0,
      },
    });
  }

  await audit({ actorRole: 'admin', actorId: adminId, action: 'REVIEW_MODERATED', entityType: 'DriverHireReview', entityId: review._id, changeSummary: { from, to: status } });
  return { id: String(review._id), moderationStatus: review.moderationStatus };
};

export const adminListReviews = async ({ status = '' } = {}) => DriverHireReview
  .find(status ? { moderationStatus: status } : {})
  .sort({ createdAt: -1 })
  .limit(200)
  .lean();

// ── Support and safety cases ────────────────────────────────────────────────

const serializeCase = (entry) => ({
  id: String(entry._id),
  caseCode: entry.caseCode,
  bookingId: entry.bookingId ? String(entry.bookingId) : null,
  category: entry.category,
  priority: entry.priority,
  description: entry.description,
  status: entry.status,
  resolutionNotes: entry.resolutionNotes || '',
  createdAt: entry.createdAt,
  resolvedAt: entry.resolvedAt || null,
});

/** POST /support-cases — customer or driver reports a problem, linked to a booking if given. */
export const createSupportCase = async ({ role, actorId, payload }) => {
  const category = String(payload?.category || '').toUpperCase();
  if (!DRIVER_HIRE_SUPPORT_CATEGORIES.includes(category)) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_SUPPORT_CASE, `category must be one of ${DRIVER_HIRE_SUPPORT_CATEGORIES.join(', ')}.`);
  }
  const description = String(payload?.description || '').trim();
  if (description.length < 5 || description.length > 2000) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_SUPPORT_CASE, 'Describe the problem in 5 to 2000 characters.');
  }

  let bookingId = null;
  const rawBooking = payload?.bookingId ?? payload?.booking_id;
  if (rawBooking) {
    const booking = await loadBooking(rawBooking);
    if (!partyOf(booking, role, actorId)) {
      throw driverHireError(404, DRIVER_HIRE_ERRORS.BOOKING_NOT_FOUND, 'Booking not found.');
    }
    bookingId = booking._id;
  }

  const entry = await DriverHireSupportCase.create({
    caseCode: newCaseCode(),
    bookingId,
    raisedByRole: role,
    raisedById: actorId,
    category,
    priority: DRIVER_HIRE_URGENT_CATEGORIES.includes(category) ? 'URGENT' : 'NORMAL',
    description,
  });

  await audit({ actorRole: role, actorId, action: 'SUPPORT_CASE_CREATED', entityType: 'DriverHireSupportCase', entityId: entry._id, changeSummary: { category, bookingId } });
  return serializeCase(entry);
};

export const listMySupportCases = async ({ role, actorId }) => {
  const cases = await DriverHireSupportCase.find({ raisedByRole: role, raisedById: actorId }).sort({ createdAt: -1 }).limit(50).lean();
  return cases.map(serializeCase);
};

export const adminListSupportCases = async ({ status = '', priority = '', bookingId = '' } = {}) => {
  const filter = {};
  if (status) filter.status = String(status).toUpperCase();
  if (priority) filter.priority = String(priority).toUpperCase();
  if (isObjectId(bookingId)) filter.bookingId = bookingId;
  const cases = await DriverHireSupportCase.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  const rank = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
  cases.sort((a, b) => rank[a.priority] - rank[b.priority]);
  return cases.map((entry) => ({ ...serializeCase(entry), raisedByRole: entry.raisedByRole, raisedById: String(entry.raisedById) }));
};

export const adminUpdateSupportCase = async ({ adminId, caseId, payload }) => {
  if (!isObjectId(caseId)) throw driverHireError(404, DRIVER_HIRE_ERRORS.SUPPORT_CASE_NOT_FOUND, 'Case not found.');
  const entry = await DriverHireSupportCase.findById(caseId);
  if (!entry) throw driverHireError(404, DRIVER_HIRE_ERRORS.SUPPORT_CASE_NOT_FOUND, 'Case not found.');

  const before = { status: entry.status, priority: entry.priority };
  if (payload?.status) {
    const status = String(payload.status).toUpperCase();
    if (!Object.values(DRIVER_HIRE_SUPPORT_STATUS).includes(status)) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_SUPPORT_CASE, 'Unknown status.');
    }
    entry.status = status;
    if ([DRIVER_HIRE_SUPPORT_STATUS.RESOLVED, DRIVER_HIRE_SUPPORT_STATUS.CLOSED].includes(status)) {
      if (!String(payload.resolutionNotes ?? entry.resolutionNotes ?? '').trim()) {
        throw driverHireError(422, DRIVER_HIRE_ERRORS.REASON_REQUIRED, 'Add resolution notes before resolving.');
      }
      entry.resolvedAt = entry.resolvedAt || new Date();
    }
  }
  if (payload?.priority) {
    const priority = String(payload.priority).toUpperCase();
    if (!['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(priority)) {
      throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_SUPPORT_CASE, 'Unknown priority.');
    }
    entry.priority = priority;
  }
  if (payload?.resolutionNotes !== undefined) entry.resolutionNotes = String(payload.resolutionNotes).slice(0, 2000);
  entry.assignedTo = entry.assignedTo || adminId;
  await entry.save();

  await audit({ actorRole: 'admin', actorId: adminId, action: 'SUPPORT_CASE_UPDATED', entityType: 'DriverHireSupportCase', entityId: entry._id, changeSummary: { before, after: { status: entry.status, priority: entry.priority } } });
  return serializeCase(entry);
};
