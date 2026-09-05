import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import { otpSendRateLimit, otpVerifyRateLimit } from '../../middlewares/rateLimitMiddleware.js';
import * as studentController from '../controllers/studentController.js';

export const studentRideRouter = Router();

const asUser = authenticate(['user']);

// Students
studentRideRouter.get('/student-ride/students', asUser, asyncHandler(studentController.listStudents));
studentRideRouter.post('/student-ride/students', asUser, asyncHandler(studentController.createStudent));
studentRideRouter.get('/student-ride/students/:studentId', asUser, asyncHandler(studentController.getStudent));
studentRideRouter.patch('/student-ride/students/:studentId', asUser, asyncHandler(studentController.updateStudent));
studentRideRouter.delete('/student-ride/students/:studentId', asUser, asyncHandler(studentController.deactivateStudent));
studentRideRouter.post('/student-ride/students/:studentId/activate', asUser, asyncHandler(studentController.reactivateStudent));

// Guardians
studentRideRouter.get('/student-ride/students/:studentId/guardians', asUser, asyncHandler(studentController.listGuardians));
studentRideRouter.post('/student-ride/students/:studentId/guardians', asUser, asyncHandler(studentController.addGuardian));
studentRideRouter.patch('/student-ride/guardians/:guardianId', asUser, asyncHandler(studentController.updateGuardian));
studentRideRouter.delete('/student-ride/guardians/:guardianId', asUser, asyncHandler(studentController.removeGuardian));

// Saved locations
studentRideRouter.get('/student-ride/students/:studentId/locations', asUser, asyncHandler(studentController.listSavedLocations));
studentRideRouter.post('/student-ride/students/:studentId/locations', asUser, asyncHandler(studentController.createSavedLocation));
studentRideRouter.get('/student-ride/locations/:locationId', asUser, asyncHandler(studentController.getSavedLocation));
studentRideRouter.patch('/student-ride/locations/:locationId', asUser, asyncHandler(studentController.updateSavedLocation));
studentRideRouter.delete('/student-ride/locations/:locationId', asUser, asyncHandler(studentController.deleteSavedLocation));

// Rides — booked and managed by the parent account.
studentRideRouter.post('/student-ride/rides', asUser, asyncHandler(studentController.createStudentRide));
studentRideRouter.get('/student-ride/rides', asUser, asyncHandler(studentController.listStudentRides));
studentRideRouter.get('/student-ride/rides/upcoming', asUser, asyncHandler(studentController.listUpcomingStudentRides));
studentRideRouter.get('/student-ride/rides/:studentRideId', asUser, asyncHandler(studentController.getStudentRide));
studentRideRouter.post('/student-ride/rides/:studentRideId/cancel', asUser, asyncHandler(studentController.cancelStudentRide));
studentRideRouter.post('/student-ride/rides/:studentRideId/otp/:kind/reissue', otpSendRateLimit, asUser, asyncHandler(studentController.reissueRideOtp));

// Driver-facing: the assigned driver verifies codes and advances the ride.
studentRideRouter.post(
  '/student-ride/rides/:studentRideId/:kind/verify',
  otpVerifyRateLimit,
  authenticate(['driver']),
  asyncHandler(studentController.verifyRideOtp),
);
studentRideRouter.post(
  '/student-ride/rides/:studentRideId/status',
  authenticate(['driver']),
  asyncHandler(studentController.advanceStudentRide),
);
