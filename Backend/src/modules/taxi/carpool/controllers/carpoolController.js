import * as vehicleService from '../services/carpoolVehicleService.js';
import * as rideService from '../services/carpoolRideService.js';

export const listVehicles = async (req, res) => {
  const vehicles = await vehicleService.listVehicles({ userId: req.auth.sub });
  res.json({ success: true, data: { vehicles } });
};

export const createVehicle = async (req, res) => {
  const vehicle = await vehicleService.createVehicle({ userId: req.auth.sub, payload: req.body });
  res.status(201).json({ success: true, data: { vehicle } });
};

export const updateVehicle = async (req, res) => {
  const vehicle = await vehicleService.updateVehicle({
    vehicleId: req.params.vehicleId,
    userId: req.auth.sub,
    payload: req.body,
  });

  res.json({ success: true, data: { vehicle } });
};

export const deleteVehicle = async (req, res) => {
  const result = await vehicleService.deleteVehicle({
    vehicleId: req.params.vehicleId,
    userId: req.auth.sub,
  });

  res.json({ success: true, data: result });
};

export const createRide = async (req, res) => {
  const ride = await rideService.createRide({ userId: req.auth.sub, payload: req.body });

  res.status(201).json({
    success: true,
    message: 'Ride published successfully',
    data: ride,
  });
};

export const searchRides = async (req, res) => {
  const rides = await rideService.searchRides({ userId: req.auth.sub, query: req.query });
  res.json({ success: true, data: { rides } });
};

export const getRide = async (req, res) => {
  const ride = await rideService.getRideById({ rideId: req.params.rideId, userId: req.auth.sub });
  res.json({ success: true, data: ride });
};

export const listMyOfferedRides = async (req, res) => {
  const rides = await rideService.listMyOfferedRides({
    userId: req.auth.sub,
    status: req.query?.status,
  });

  res.json({ success: true, data: { rides } });
};
