import * as vehicleService from '../services/carpoolVehicleService.js';
import * as rideService from '../services/carpoolRideService.js';
import * as bookingService from '../services/carpoolBookingService.js';
import * as ratingService from '../services/carpoolRatingService.js';
import * as tripsService from '../services/carpoolTripsService.js';
import * as documentService from '../services/carpoolDocumentService.js';
import { priceLimitFor } from '../services/carpoolPricingService.js';
import { carpoolError } from '../services/carpoolVehicleService.js';

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

export const createRating = async (req, res) => {
  const rating = await ratingService.createRating({ userId: req.auth.sub, payload: req.body });
  res.status(201).json({ success: true, data: rating });
};

export const listPendingRatings = async (req, res) => {
  const pending = await ratingService.listRatableBookings({ userId: req.auth.sub });
  res.json({ success: true, data: { pending } });
};

export const getMyStats = async (req, res) => {
  const stats = await ratingService.getUserStats(req.auth.sub);
  res.json({ success: true, data: stats });
};

export const listUserRatings = async (req, res) => {
  const ratings = await ratingService.listRatingsForUser({
    userId: req.params.userId,
    role: req.query?.role,
  });

  res.json({ success: true, data: { ratings } });
};

export const getMyTrips = async (req, res) => {
  const trips = await tripsService.getMyTrips({
    userId: req.auth.sub,
    type: String(req.query?.type || 'all').toLowerCase(),
    status: req.query?.status,
  });

  res.json({ success: true, data: trips });
};

export const getHome = async (req, res) => {
  const home = await tripsService.getCarpoolHome({ userId: req.auth.sub });
  res.json({ success: true, data: home });
};

// --- Host documents (Offer Ride verification) --------------------------------

export const uploadDocument = async (req, res) => {
  const document = await documentService.uploadDocument({ userId: req.auth.sub, payload: req.body });
  res.status(201).json({ success: true, data: { document } });
};

export const getDocumentStatus = async (req, res) => {
  const data = await documentService.getDocumentStatus({ userId: req.auth.sub });
  res.json({ success: true, data });
};

// --- Price ceiling for the publish screen ------------------------------------

/**
 * The most a host may charge per seat on a route. Takes the endpoints and any
 * stops ("lat,lng|lat,lng"), in travel order.
 */
export const getPriceLimit = async (req, res) => {
  const point = (lat, lng, field) => {
    const coords = [Number(lng), Number(lat)];
    if (!coords.every(Number.isFinite)) {
      throw carpoolError(422, 'INVALID_ROUTE', `${field} is required.`);
    }
    return coords;
  };

  const stops = String(req.query.stops || '')
    .split('|')
    .filter(Boolean)
    .map((pair) => {
      const [lat, lng] = pair.split(',');
      return point(lat, lng, 'stops');
    });

  const coordinates = [
    point(req.query.from_lat ?? req.query.pickup_lat, req.query.from_lng ?? req.query.pickup_lng, 'from_lat/from_lng'),
    ...stops,
    point(req.query.to_lat ?? req.query.drop_lat, req.query.to_lng ?? req.query.drop_lng, 'to_lat/to_lng'),
  ];

  const limit = await priceLimitFor(coordinates);
  res.json({ success: true, data: limit });
};

// --- Admin: document review --------------------------------------------------

export const adminListDocuments = async (req, res) => {
  const data = await documentService.listDocumentsForAdmin(req.query);
  res.json({ success: true, data });
};

export const adminApproveDocument = async (req, res) => {
  const document = await documentService.approveDocument({ documentId: req.params.documentId, adminId: req.auth.sub });
  res.json({ success: true, data: { document } });
};

export const adminRejectDocument = async (req, res) => {
  const document = await documentService.rejectDocument({
    documentId: req.params.documentId,
    adminId: req.auth.sub,
    reason: req.body?.reason,
  });
  res.json({ success: true, data: { document } });
};
