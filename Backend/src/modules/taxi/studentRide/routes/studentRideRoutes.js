import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
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
