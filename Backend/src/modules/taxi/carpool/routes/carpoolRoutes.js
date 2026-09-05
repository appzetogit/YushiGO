import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import * as carpool from '../controllers/carpoolController.js';

export const carpoolRouter = Router();

const asUser = authenticate(['user']);

// Vehicles — a carpool host is an ordinary user, so these are their own cars.
carpoolRouter.get('/carpool/vehicles', asUser, asyncHandler(carpool.listVehicles));
carpoolRouter.post('/carpool/vehicles', asUser, asyncHandler(carpool.createVehicle));
carpoolRouter.patch('/carpool/vehicles/:vehicleId', asUser, asyncHandler(carpool.updateVehicle));
carpoolRouter.delete('/carpool/vehicles/:vehicleId', asUser, asyncHandler(carpool.deleteVehicle));

// Rides. `search` and `my-offered-rides` are declared before `/:rideId` so the
// literal segments are not captured by the parameter route.
carpoolRouter.post('/carpool/rides', asUser, asyncHandler(carpool.createRide));
carpoolRouter.get('/carpool/rides/search', asUser, asyncHandler(carpool.searchRides));
carpoolRouter.get('/carpool/my-offered-rides', asUser, asyncHandler(carpool.listMyOfferedRides));
carpoolRouter.get('/carpool/rides/:rideId', asUser, asyncHandler(carpool.getRide));
