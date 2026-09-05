import * as vehicleService from '../services/carpoolVehicleService.js';
import * as rideService from '../services/carpoolRideService.js';
import * as bookingService from '../services/carpoolBookingService.js';

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

export const createBooking = async (req, res) => {
  const booking = await bookingService.createBooking({
    rideId: req.params.rideId,
    userId: req.auth.sub,
    payload: req.body,
  });

  res.status(201).json({ success: true, data: booking });
};

export const getBooking = async (req, res) => {
  const booking = await bookingService.getBooking({
    bookingId: req.params.bookingId,
    userId: req.auth.sub,
  });

  res.json({ success: true, data: booking });
};

export const listRideRequests = async (req, res) => {
  const requests = await bookingService.listRideRequests({
    rideId: req.params.rideId,
    userId: req.auth.sub,
    status: req.query?.status,
  });

  res.json({ success: true, data: { requests } });
};

export const acceptBooking = async (req, res) => {
  const booking = await bookingService.acceptBooking({
    bookingId: req.params.bookingId,
    userId: req.auth.sub,
  });

  res.json({ success: true, message: 'Booking accepted', data: booking });
};

export const rejectBooking = async (req, res) => {
  const booking = await bookingService.rejectBooking({
    bookingId: req.params.bookingId,
    userId: req.auth.sub,
    reason: req.body?.reason,
  });

  res.json({ success: true, message: 'Booking rejected', data: booking });
};

export const cancelBooking = async (req, res) => {
  const booking = await bookingService.cancelBookingByPassenger({
    bookingId: req.params.bookingId,
    userId: req.auth.sub,
    reason: req.body?.reason,
  });

  res.json({ success: true, message: 'Booking cancelled', data: booking });
};

export const listMyBookings = async (req, res) => {
  const bookings = await bookingService.listMyBookings({
    userId: req.auth.sub,
    status: req.query?.status,
  });

  res.json({ success: true, data: { bookings } });
};

export const cancelRide = async (req, res) => {
  const result = await bookingService.cancelRide({
    rideId: req.params.rideId,
    userId: req.auth.sub,
    reason: req.body?.reason,
  });

  res.json({ success: true, message: 'Ride cancelled', data: result });
};

export const startRide = async (req, res) => {
  const result = await bookingService.startRide({
    rideId: req.params.rideId,
    userId: req.auth.sub,
  });

  res.json({ success: true, message: 'Ride started', data: result });
};

export const completeRide = async (req, res) => {
  const result = await bookingService.completeRide({
    rideId: req.params.rideId,
    userId: req.auth.sub,
  });

  res.json({ success: true, message: 'Ride completed', data: result });
};
