import * as vehicleService from '../services/vehicleService.js';
import * as bookingService from '../services/bookingService.js';
import * as lifecycle from '../services/lifecycleService.js';
import * as profileService from '../services/profileService.js';
import * as feedback from '../services/feedbackService.js';
import * as adminService from '../services/adminService.js';
import * as pricingService from '../services/pricingService.js';
import * as paymentService from '../services/paymentService.js';

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const isDriver = (req) => req.auth.role === 'driver';

// ── Customer: saved cars ────────────────────────────────────────────────────
export const listVehicles = async (req, res) => ok(res, { vehicles: await vehicleService.listVehicles({ customerId: req.auth.sub }) });
export const createVehicle = async (req, res) => ok(res, { vehicle: await vehicleService.createVehicle({ customerId: req.auth.sub, payload: req.body }) }, 201);
export const updateVehicle = async (req, res) => ok(res, {
  vehicle: await vehicleService.updateVehicle({ customerId: req.auth.sub, vehicleId: req.params.vehicleId, payload: req.body }),
});
export const deleteVehicle = async (req, res) => ok(res, await vehicleService.deleteVehicle({ customerId: req.auth.sub, vehicleId: req.params.vehicleId }));

// ── Customer: booking ───────────────────────────────────────────────────────
export const createQuote = async (req, res) => ok(res, await bookingService.createQuote({ customerId: req.auth.sub, payload: req.body }), 201);
export const createBooking = async (req, res) => ok(res, await bookingService.createBooking({ customerId: req.auth.sub, payload: req.body }), 201);
export const checkAvailability = async (req, res) => ok(res, await bookingService.checkAvailability({ query: req.query }));
export const confirmArrival = async (req, res) => ok(res, await bookingService.confirmArrival({ customerId: req.auth.sub, bookingId: req.params.bookingId }));

/** GET /driver-bookings — the caller's own bookings, customer or driver. */
export const listBookings = async (req, res) => {
  const scope = String(req.query?.scope || '');
  const bookings = isDriver(req)
    ? await lifecycle.listDriverBookings({ driverId: req.auth.sub, scope })
    : await bookingService.listMyBookings({ customerId: req.auth.sub, scope });
  ok(res, { bookings });
};

/** GET /driver-bookings/{id} — each party gets their own view. */
export const getBooking = async (req, res) => ok(res, isDriver(req)
  ? await lifecycle.getDriverBooking({ driverId: req.auth.sub, bookingId: req.params.bookingId })
  : await bookingService.getBooking({ customerId: req.auth.sub, bookingId: req.params.bookingId }));

/** POST /driver-bookings/{id}/cancel — the customer cancels, or the driver steps away. */
export const cancelBooking = async (req, res) => ok(res, isDriver(req)
  ? await lifecycle.cancelByDriver({ driverId: req.auth.sub, bookingId: req.params.bookingId, reason: req.body?.reason })
  : await bookingService.cancelByCustomer({ customerId: req.auth.sub, bookingId: req.params.bookingId, reason: req.body?.reason }));

export const rateBooking = async (req, res) => ok(res, await feedback.createReview({
  role: req.auth.role,
  actorId: req.auth.sub,
  bookingId: req.params.bookingId,
  payload: req.body,
}), 201);

// ── Driver ──────────────────────────────────────────────────────────────────
export const getMyProfile = async (req, res) => ok(res, await profileService.getMyProfile({ driverId: req.auth.sub }));
export const submitProfile = async (req, res) => ok(res, await profileService.submitProfile({ driverId: req.auth.sub, payload: req.body }));
export const setOnline = async (req, res) => ok(res, { profile: await profileService.setOnline({ driverId: req.auth.sub, online: req.body?.online === true }) });
export const listRequests = async (req, res) => ok(res, { requests: await lifecycle.listRequests({ driverId: req.auth.sub }) });
export const getEarnings = async (req, res) => ok(res, await lifecycle.getEarnings({ driverId: req.auth.sub }));

const driverAction = (fn) => async (req, res) => ok(res, await fn({
  driverId: req.auth.sub,
  bookingId: req.params.bookingId,
  payload: req.body,
  reason: req.body?.reason,
}));

export const acceptBooking = driverAction(lifecycle.acceptBooking);
export const declineBooking = driverAction(lifecycle.declineBooking);
export const markEnRoute = driverAction(lifecycle.markEnRoute);
export const markArrived = driverAction(lifecycle.markArrived);
export const startTrip = driverAction(lifecycle.startTrip);
export const completeTrip = driverAction(lifecycle.completeTrip);
export const reportNoShow = driverAction(lifecycle.reportNoShow);
export const updateLocation = driverAction(lifecycle.updateLocation);

// ── Support (both apps) ─────────────────────────────────────────────────────
export const createSupportCase = async (req, res) => ok(res, await feedback.createSupportCase({ role: req.auth.role, actorId: req.auth.sub, payload: req.body }), 201);
export const listMySupportCases = async (req, res) => ok(res, { cases: await feedback.listMySupportCases({ role: req.auth.role, actorId: req.auth.sub }) });

// ── Admin ───────────────────────────────────────────────────────────────────
const adminId = (req) => req.auth.sub;

export const adminListBookings = async (req, res) => ok(res, await adminService.listBookings({ query: req.query }));
export const adminGetBooking = async (req, res) => ok(res, await adminService.getBookingDetail({ bookingId: req.params.bookingId }));
export const adminEligibleDrivers = async (req, res) => ok(res, { drivers: await adminService.eligibleDrivers({ bookingId: req.params.bookingId }) });
export const adminAssign = async (req, res) => ok(res, await adminService.assignBooking({ adminId: adminId(req), bookingId: req.params.bookingId, payload: req.body }));
export const adminReassign = async (req, res) => ok(res, await adminService.reassignBooking({ adminId: adminId(req), bookingId: req.params.bookingId, reason: req.body?.reason }));
export const adminCancel = async (req, res) => ok(res, await adminService.cancelBooking({ adminId: adminId(req), bookingId: req.params.bookingId, payload: req.body }));
export const adminOpenDispute = async (req, res) => ok(res, await adminService.openDispute({ adminId: adminId(req), bookingId: req.params.bookingId, note: req.body?.note }));
export const adminResolveDispute = async (req, res) => ok(res, await adminService.resolveDispute({ adminId: adminId(req), bookingId: req.params.bookingId, payload: req.body }));

export const adminListDrivers = async (req, res) => ok(res, {
  profiles: await profileService.adminListProfiles({ status: req.query?.status, expiringWithinDays: req.query?.expiringWithinDays }),
});
export const adminGetDriver = async (req, res) => ok(res, await profileService.adminGetProfile({ adminId: adminId(req), profileId: req.params.profileId }));
export const adminReviewDriver = (action) => async (req, res) => ok(res, await profileService.adminReviewProfile({
  adminId: adminId(req),
  profileId: req.params.profileId,
  action,
  reason: req.body?.reason,
}));

export const adminListPricing = async (req, res) => ok(res, { pricing: await pricingService.listPricing({ includeHistory: req.query?.history === 'true' }) });
export const adminPublishPricing = async (req, res) => ok(res, { pricing: await pricingService.publishPricing({ adminId: adminId(req), payload: req.body }) }, 201);

export const adminListPayments = async (req, res) => ok(res, { payments: await adminService.listPayments({ query: req.query }) });
export const adminSetPaymentStatus = async (req, res) => ok(res, await paymentService.adminSetPaymentStatus({
  adminId: adminId(req),
  paymentId: req.params.paymentId,
  status: String(req.body?.status || '').toUpperCase(),
  gatewayReference: req.body?.gatewayReference,
}));
export const adminRefund = async (req, res) => ok(res, await paymentService.recordRefund({
  adminId: adminId(req),
  paymentId: req.params.paymentId,
  amount: req.body?.amount,
  reason: req.body?.reason,
  completed: req.body?.completed === true,
}));

export const adminListSupportCases = async (req, res) => ok(res, { cases: await feedback.adminListSupportCases(req.query || {}) });
export const adminUpdateSupportCase = async (req, res) => ok(res, await feedback.adminUpdateSupportCase({ adminId: adminId(req), caseId: req.params.caseId, payload: req.body }));
export const adminListReviews = async (req, res) => ok(res, { reviews: await feedback.adminListReviews({ status: req.query?.status }) });
export const adminModerateReview = async (req, res) => ok(res, await feedback.adminModerateReview({
  adminId: adminId(req),
  reviewId: req.params.reviewId,
  status: String(req.body?.status || '').toUpperCase(),
}));

export const adminReport = async (req, res) => ok(res, await adminService.getReport({ query: req.query }));
export const adminAudit = async (req, res) => ok(res, { entries: await adminService.listAudit({ query: req.query }) });
