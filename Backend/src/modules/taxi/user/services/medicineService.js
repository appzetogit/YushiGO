import { ApiError } from '../../../../utils/ApiError.js';
import { normalizePoint } from '../../../../utils/geo.js';
import { Pharmacy } from '../../admin/models/Pharmacy.js';
import { startDispatchFlow } from '../../services/dispatchService.js';
import { Delivery } from '../models/Delivery.js';
import {
  createRideRecord,
  ensureRideParticipantAccess,
  getActiveRideForIdentity,
  getRideDetails,
  getRideRoom,
  listRideHistoryForIdentity,
  serializeRideRealtime,
} from '../../services/rideService.js';

const ensureMedicineRide = (ride) => {
  if (!ride || String(ride.serviceType || ride.type || 'ride').toLowerCase() !== 'medicine') {
    throw new ApiError(404, 'Medicine order not found');
  }

  return ride;
};

export const serializeMedicineRealtime = (ride) => {
  const serializedRide = serializeRideRealtime(ride);

  return {
    ...serializedRide,
    medicineOrderId: ride.deliveryId?._id ? String(ride.deliveryId._id) : ride.deliveryId ? String(ride.deliveryId) : null,
    rideId: String(ride._id),
    room: getRideRoom(ride._id),
    type: 'medicine',
    serviceType: 'medicine',
  };
};

export const createMedicineOrderRecord = async ({
  userId,
  pickup,
  drop,
  pickupAddress,
  dropAddress,
  fare,
  vehicleTypeId,
  vehicleTypeIds,
  vehicleIconType,
  vehicleIconUrl,
  paymentMethod,
  medicine,
}) => {
  const pickupCoords = normalizePoint(pickup, 'pickup');
  const dropCoords = normalizePoint(drop, 'drop');

  const ride = await createRideRecord({
    userId,
    pickupCoords,
    dropCoords,
    pickupAddress,
    dropAddress,
    fare,
    vehicleTypeId,
    vehicleTypeIds,
    vehicleIconType,
    vehicleIconUrl,
    paymentMethod,
    transport_type: 'delivery',
    serviceType: 'medicine',
    medicine,
  });

  await startDispatchFlow(ride);

  const detailedRide = await getRideDetails(ride._id);
  return serializeMedicineRealtime(ensureMedicineRide(detailedRide));
};

export const getActiveMedicineOrderForIdentity = async ({ role, entityId }) => {
  const ride = await getActiveRideForIdentity({ role, entityId });

  if (!ride) {
    return null;
  }

  if (String(ride.serviceType || ride.type || 'ride').toLowerCase() !== 'medicine') {
    return null;
  }

  return serializeMedicineRealtime(ride);
};

export const getMedicineOrderById = async ({ medicineOrderId, role, entityId }) => {
  const delivery = await Delivery.findById(medicineOrderId).select('rideId');

  if (!delivery?.rideId) {
    throw new ApiError(404, 'Medicine order not found');
  }

  await ensureRideParticipantAccess({ rideId: delivery.rideId, role, entityId });
  const ride = await getRideDetails(delivery.rideId);
  return serializeMedicineRealtime(ensureMedicineRide(ride));
};

export const listMedicineOrdersForIdentity = async ({ role, entityId, limit }) => {
  const rides = await listRideHistoryForIdentity({ role, entityId, limit });
  return rides
    .filter((ride) => String(ride.serviceType || ride.type || 'ride').toLowerCase() === 'medicine')
    .map((ride) => ({
      ...ride,
      type: 'medicine',
      serviceType: 'medicine',
    }));
};

export const listActivePharmacies = async () => {
  const pharmacies = await Pharmacy.find({ active: true }).sort({ name: 1 }).lean();
  return pharmacies;
};
