import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import {
  getSchedules,
  getScheduleAvailability,
  searchVehicles,
} from '../controllers/groupTravelController.js';

export const groupTravelRouter = Router();

// Group & Large Vehicles: published seat trips (book a seat / scheduled travel) and whole-vehicle search.
// Seat booking itself goes through /users/bus-bookings/order with the busServiceId/scheduleId from these results.
groupTravelRouter.get('/schedules', authenticate(['user']), asyncHandler(getSchedules));
groupTravelRouter.get('/schedules/:id/availability', authenticate(['user']), asyncHandler(getScheduleAvailability));
groupTravelRouter.post('/search/vehicles', authenticate(['user']), asyncHandler(searchVehicles));
