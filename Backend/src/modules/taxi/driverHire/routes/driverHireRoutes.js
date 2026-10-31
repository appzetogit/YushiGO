import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import * as hire from '../controllers/driverHireController.js';

export const driverHireRouter = Router();

const asUser = authenticate(['user']);
const asDriver = authenticate(['driver']);
const asEither = authenticate(['user', 'driver']);

// Customer: their own cars. Only make, model and transmission are collected.
driverHireRouter.get('/driver-hire/vehicles', asUser, asyncHandler(hire.listVehicles));
driverHireRouter.post('/driver-hire/vehicles', asUser, asyncHandler(hire.createVehicle));
driverHireRouter.patch('/driver-hire/vehicles/:vehicleId', asUser, asyncHandler(hire.updateVehicle));
driverHireRouter.delete('/driver-hire/vehicles/:vehicleId', asUser, asyncHandler(hire.deleteVehicle));

// Driver: profile, online toggle, open requests, earnings.
driverHireRouter.get('/driver-hire/profile', asDriver, asyncHandler(hire.getMyProfile));
driverHireRouter.put('/driver-hire/profile', asDriver, asyncHandler(hire.submitProfile));
driverHireRouter.post('/driver-hire/online', asDriver, asyncHandler(hire.setOnline));
driverHireRouter.get('/driver-hire/requests', asDriver, asyncHandler(hire.listRequests));
driverHireRouter.get('/driver-hire/earnings', asDriver, asyncHandler(hire.getEarnings));

// Availability: a count for the customer, never who.
driverHireRouter.get('/drivers/availability', asUser, asyncHandler(hire.checkAvailability));

// Bookings. `quote` is declared before `/:bookingId` so the literal segment is
// not captured by the parameter route.
driverHireRouter.post('/driver-bookings/quote', asUser, asyncHandler(hire.createQuote));
driverHireRouter.get('/driver-bookings/event-packages', asUser, asyncHandler(hire.listEventPackages));
driverHireRouter.post('/driver-bookings', asUser, asyncHandler(hire.createBooking));
driverHireRouter.get('/driver-bookings', asEither, asyncHandler(hire.listBookings));
driverHireRouter.get('/driver-bookings/:bookingId', asEither, asyncHandler(hire.getBooking));
driverHireRouter.post('/driver-bookings/:bookingId/cancel', asEither, asyncHandler(hire.cancelBooking));
driverHireRouter.post('/driver-bookings/:bookingId/confirm-arrival', asUser, asyncHandler(hire.confirmArrival));
driverHireRouter.post('/driver-bookings/:bookingId/rate', asEither, asyncHandler(hire.rateBooking));

// Driver lifecycle on a booking.
driverHireRouter.post('/driver-bookings/:bookingId/accept', asDriver, asyncHandler(hire.acceptBooking));
driverHireRouter.post('/driver-bookings/:bookingId/decline', asDriver, asyncHandler(hire.declineBooking));
driverHireRouter.post('/driver-bookings/:bookingId/en-route', asDriver, asyncHandler(hire.markEnRoute));
driverHireRouter.post('/driver-bookings/:bookingId/arrived', asDriver, asyncHandler(hire.markArrived));
driverHireRouter.post('/driver-bookings/:bookingId/start', asDriver, asyncHandler(hire.startTrip));
driverHireRouter.post('/driver-bookings/:bookingId/complete', asDriver, asyncHandler(hire.completeTrip));
driverHireRouter.post('/driver-bookings/:bookingId/no-show', asDriver, asyncHandler(hire.reportNoShow));
driverHireRouter.post('/driver-bookings/:bookingId/location', asDriver, asyncHandler(hire.updateLocation));

// Support and safety, from either app.
driverHireRouter.post('/support-cases', asEither, asyncHandler(hire.createSupportCase));
driverHireRouter.get('/support-cases', asEither, asyncHandler(hire.listMySupportCases));

// Admin. Authenticated here rather than relying on the admin router's prefix
// guard, so it holds regardless of mount order.
const asAdmin = authenticate(['admin']);
const admin = (path) => `/admin/driver-hire${path}`;

driverHireRouter.get(admin('/bookings'), asAdmin, asyncHandler(hire.adminListBookings));
driverHireRouter.get(admin('/bookings/:bookingId'), asAdmin, asyncHandler(hire.adminGetBooking));
driverHireRouter.get(admin('/bookings/:bookingId/eligible-drivers'), asAdmin, asyncHandler(hire.adminEligibleDrivers));
driverHireRouter.post(admin('/bookings/:bookingId/assign'), asAdmin, asyncHandler(hire.adminAssign));
driverHireRouter.post(admin('/bookings/:bookingId/reassign'), asAdmin, asyncHandler(hire.adminReassign));
driverHireRouter.post(admin('/bookings/:bookingId/cancel'), asAdmin, asyncHandler(hire.adminCancel));
driverHireRouter.post(admin('/bookings/:bookingId/dispute'), asAdmin, asyncHandler(hire.adminOpenDispute));
driverHireRouter.post(admin('/bookings/:bookingId/resolve'), asAdmin, asyncHandler(hire.adminResolveDispute));

driverHireRouter.get(admin('/drivers'), asAdmin, asyncHandler(hire.adminListDrivers));
driverHireRouter.get(admin('/drivers/:profileId'), asAdmin, asyncHandler(hire.adminGetDriver));
for (const action of ['approve', 'reject', 'suspend', 'reinstate']) {
  driverHireRouter.post(admin(`/drivers/:profileId/${action}`), asAdmin, asyncHandler(hire.adminReviewDriver(action)));
}

driverHireRouter.get(admin('/pricing'), asAdmin, asyncHandler(hire.adminListPricing));
driverHireRouter.post(admin('/pricing'), asAdmin, asyncHandler(hire.adminPublishPricing));

driverHireRouter.get(admin('/payments'), asAdmin, asyncHandler(hire.adminListPayments));
driverHireRouter.post(admin('/payments/:paymentId/status'), asAdmin, asyncHandler(hire.adminSetPaymentStatus));
driverHireRouter.post(admin('/payments/:paymentId/refund'), asAdmin, asyncHandler(hire.adminRefund));

driverHireRouter.get(admin('/support-cases'), asAdmin, asyncHandler(hire.adminListSupportCases));
driverHireRouter.patch(admin('/support-cases/:caseId'), asAdmin, asyncHandler(hire.adminUpdateSupportCase));
driverHireRouter.get(admin('/reviews'), asAdmin, asyncHandler(hire.adminListReviews));
driverHireRouter.post(admin('/reviews/:reviewId/moderate'), asAdmin, asyncHandler(hire.adminModerateReview));

driverHireRouter.get(admin('/reports'), asAdmin, asyncHandler(hire.adminReport));
driverHireRouter.get(admin('/audit'), asAdmin, asyncHandler(hire.adminAudit));
