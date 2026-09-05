import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { CarpoolVehicle } from '../models/CarpoolVehicle.js';
import { CARPOOL_ERRORS, CARPOOL_VEHICLE_VERIFICATION, carpoolConfig } from '../constants/index.js';

export const carpoolError = (status, code, message) => {
  const error = new ApiError(status, message);
  error.code = code;
  return error;
};

/**
 * Vehicle documents are never included — §42. Only the verification badge is
 * exposed, which is what a passenger needs to judge a ride.
 */
export const serializeVehicle = (vehicle) => ({
  id: String(vehicle._id),
  make: vehicle.make || '',
  model: vehicle.model,
  color: vehicle.color || '',
  vehicleType: vehicle.vehicleType || 'car',
  registrationNumber: vehicle.registrationNumber,
  seatCapacity: vehicle.seatCapacity,
  hasAc: Boolean(vehicle.hasAc),
  photoUrl: vehicle.photoUrl || '',
  verified: vehicle.verificationStatus === CARPOOL_VEHICLE_VERIFICATION.VERIFIED,
  verificationStatus: vehicle.verificationStatus,
  createdAt: vehicle.createdAt,
});

/** What another passenger sees in search results — no registration number. */
export const serializeVehiclePublic = (vehicle) => ({
  model: vehicle.model,
  make: vehicle.make || '',
  color: vehicle.color || '',
  type: vehicle.vehicleType || 'car',
  hasAc: Boolean(vehicle.hasAc),
  verified: vehicle.verificationStatus === CARPOOL_VEHICLE_VERIFICATION.VERIFIED,
});

export const requireOwnedVehicle = async ({ vehicleId, userId }, { session = null } = {}) => {
  if (!mongoose.Types.ObjectId.isValid(String(vehicleId || ''))) {
    throw carpoolError(404, CARPOOL_ERRORS.INVALID_VEHICLE, 'Vehicle not found.');
  }

  const query = CarpoolVehicle.findOne({ _id: vehicleId, deletedAt: null });

  if (session) {
    query.session(session);
  }

  const vehicle = await query;

  if (!vehicle || String(vehicle.userId) !== String(userId)) {
    throw carpoolError(404, CARPOOL_ERRORS.INVALID_VEHICLE, 'Vehicle not found.');
  }

  return vehicle;
};

export const listVehicles = async ({ userId }) => {
  const vehicles = await CarpoolVehicle.find({ userId, deletedAt: null }).sort({ createdAt: -1 });
  return vehicles.map(serializeVehicle);
};

export const createVehicle = async ({ userId, payload }) => {
  const model = String(payload?.model || '').trim();
  const registrationNumber = String(payload?.registrationNumber || payload?.vehicle_number || '')
    .trim()
    .toUpperCase();
  const seatCapacity = Number(payload?.seatCapacity ?? payload?.seat_capacity);

  if (!model) {
    throw carpoolError(422, CARPOOL_ERRORS.INVALID_VEHICLE, 'Vehicle model is required.');
  }

  if (!registrationNumber) {
    throw carpoolError(422, CARPOOL_ERRORS.INVALID_VEHICLE, 'Registration number is required.');
  }

  if (!Number.isInteger(seatCapacity) || seatCapacity < 1 || seatCapacity > 20) {
    throw carpoolError(422, CARPOOL_ERRORS.INVALID_VEHICLE, 'seatCapacity must be a whole number between 1 and 20.');
  }

  try {
    const vehicle = await CarpoolVehicle.create({
      userId,
      model,
      registrationNumber,
      seatCapacity,
      make: String(payload?.make || '').trim(),
      color: String(payload?.color || '').trim(),
      vehicleType: String(payload?.vehicleType || 'car').trim().toLowerCase(),
      hasAc: payload?.hasAc === undefined ? true : Boolean(payload.hasAc),
      photoUrl: String(payload?.photoUrl || '').trim(),
    });

    return serializeVehicle(vehicle);
  } catch (error) {
    if (error?.code === 11000) {
      throw carpoolError(409, CARPOOL_ERRORS.INVALID_VEHICLE, 'You have already added this vehicle.');
    }

    throw error;
  }
};

export const updateVehicle = async ({ vehicleId, userId, payload }) => {
  const vehicle = await requireOwnedVehicle({ vehicleId, userId });

  for (const field of ['make', 'model', 'color', 'photoUrl']) {
    if (payload?.[field] !== undefined) {
      vehicle[field] = String(payload[field] || '').trim();
    }
  }

  if (payload?.seatCapacity !== undefined) {
    const seatCapacity = Number(payload.seatCapacity);

    if (!Number.isInteger(seatCapacity) || seatCapacity < 1 || seatCapacity > 20) {
      throw carpoolError(422, CARPOOL_ERRORS.INVALID_VEHICLE, 'seatCapacity must be a whole number between 1 and 20.');
    }

    vehicle.seatCapacity = seatCapacity;
  }

  if (payload?.hasAc !== undefined) {
    vehicle.hasAc = Boolean(payload.hasAc);
  }

  await vehicle.save();

  return serializeVehicle(vehicle);
};

export const deleteVehicle = async ({ vehicleId, userId }) => {
  const vehicle = await requireOwnedVehicle({ vehicleId, userId });

  vehicle.deletedAt = new Date();
  await vehicle.save();

  return { id: String(vehicle._id), deleted: true };
};

/**
 * Gate applied when publishing. Off by default: the badge is shown in search
 * results and the operator can require verification later by config alone.
 */
export const assertVehicleEligibleToPublish = (vehicle) => {
  if (!carpoolConfig().requireVerifiedVehicle) {
    return;
  }

  if (vehicle.verificationStatus !== CARPOOL_VEHICLE_VERIFICATION.VERIFIED) {
    throw carpoolError(
      403,
      CARPOOL_ERRORS.VEHICLE_NOT_VERIFIED,
      'This vehicle must be verified before you can publish a ride.',
    );
  }
};
