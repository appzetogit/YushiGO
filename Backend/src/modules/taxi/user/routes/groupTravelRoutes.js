import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import {
  getSchedules,
  getScheduleAvailability,
  searchVehicles,
} from '../controllers/groupTravelController.js';

export const groupTravelRouter = Router();

// Routes for Group Travel, Schedules & Vehicle Search
groupTravelRouter.get('/schedules', asyncHandler(getSchedules));
groupTravelRouter.get('/schedules/:id/availability', asyncHandler(getScheduleAvailability));
groupTravelRouter.post('/search/vehicles', asyncHandler(searchVehicles));
