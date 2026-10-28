import { DRIVER_HIRE_ERRORS, DRIVER_HIRE_TRANSMISSIONS } from '../constants/index.js';
import { CustomerVehicle } from '../models/CustomerVehicle.js';
import { driverHireError, isObjectId } from './common.js';

const MAX_VEHICLES = 10;

export const serializeVehicle = (vehicle) => ({
  id: String(vehicle._id),
  make: vehicle.make,
  model: vehicle.model,
  transmission: vehicle.transmission,
  notes: vehicle.notes || '',
});

const parseVehicle = (payload, existing = null) => {
  const make = String(payload?.make ?? existing?.make ?? '').trim();
  const model = String(payload?.model ?? existing?.model ?? '').trim();
  const transmission = String(payload?.transmission ?? existing?.transmission ?? '').toUpperCase();
  const notes = String(payload?.notes ?? existing?.notes ?? '').trim();

  if (!make || !model || make.length > 60 || model.length > 60) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_VEHICLE, 'make and model are required (60 characters each at most).');
  }
  if (!Object.values(DRIVER_HIRE_TRANSMISSIONS).includes(transmission)) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_TRANSMISSION, 'transmission must be MANUAL or AUTOMATIC.');
  }
  if (notes.length > 300) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_VEHICLE, 'notes must be 300 characters or fewer.');
  }

  return { make, model, transmission, notes };
};

export const requireOwnedVehicle = async ({ vehicleId, customerId }) => {
  if (!isObjectId(vehicleId)) {
    throw driverHireError(404, DRIVER_HIRE_ERRORS.VEHICLE_NOT_FOUND, 'Vehicle not found.');
  }
  const vehicle = await CustomerVehicle.findOne({ _id: vehicleId, customerId, deletedAt: null });
  if (!vehicle) {
    throw driverHireError(404, DRIVER_HIRE_ERRORS.VEHICLE_NOT_FOUND, 'Vehicle not found.');
  }
  return vehicle;
};

export const listVehicles = async ({ customerId }) => {
  const vehicles = await CustomerVehicle.find({ customerId, deletedAt: null }).sort({ createdAt: -1 }).lean();
  return vehicles.map(serializeVehicle);
};

export const createVehicle = async ({ customerId, payload }) => {
  const count = await CustomerVehicle.countDocuments({ customerId, deletedAt: null });
  if (count >= MAX_VEHICLES) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_VEHICLE, `You can save up to ${MAX_VEHICLES} cars.`);
  }
  const vehicle = await CustomerVehicle.create({ customerId, ...parseVehicle(payload) });
  return serializeVehicle(vehicle);
};

export const updateVehicle = async ({ customerId, vehicleId, payload }) => {
  const vehicle = await requireOwnedVehicle({ vehicleId, customerId });
  Object.assign(vehicle, parseVehicle(payload, vehicle));
  await vehicle.save();
  return serializeVehicle(vehicle);
};

/** Soft delete: past bookings keep their own snapshot of the car either way. */
export const deleteVehicle = async ({ customerId, vehicleId }) => {
  const vehicle = await requireOwnedVehicle({ vehicleId, customerId });
  vehicle.deletedAt = new Date();
  await vehicle.save();
  return { deleted: true };
};
