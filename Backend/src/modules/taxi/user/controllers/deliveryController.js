import { createDeliveryRecord, getActiveDeliveryForIdentity, getDeliveryById, listDeliveriesForIdentity, quoteDelivery, resolveOwnDeliveryRideId } from '../services/deliveryService.js';
import * as parcelHandover from '../services/parcelHandoverService.js';
import { cancelRide } from './rideController.js';

export const getDeliveryQuote = async (req, res) => {
  const { pickup, drop, vehicleTypeId, parcel } = req.body;

  const quote = await quoteDelivery({ pickup, drop, vehicleTypeId, parcel });

  res.json({
    success: true,
    data: quote,
  });
};

export const createDelivery = async (req, res) => {
  const { pickup, drop, pickupAddress, dropAddress, fare, vehicleTypeId, vehicleTypeIds, vehicleIconType, vehicleIconUrl, paymentMethod, parcel } = req.body;

  const delivery = await createDeliveryRecord({
    userId: req.auth.sub,
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
    parcel,
  });

  res.status(201).json({
    success: true,
    data: delivery,
  });
};

export const getMyActiveDelivery = async (req, res) => {
  const delivery = await getActiveDeliveryForIdentity({
    role: req.auth.role,
    entityId: req.auth.sub,
  });

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  res.json({
    success: true,
    data: delivery,
  });
};

export const getDelivery = async (req, res) => {
  const delivery = await getDeliveryById({
    deliveryId: req.params.deliveryId,
    role: req.auth.role,
    entityId: req.auth.sub,
  });

  res.json({
    success: true,
    data: delivery,
  });
};

export const listMyDeliveries = async (req, res) => {
  const deliveries = await listDeliveriesForIdentity({
    role: req.auth.role,
    entityId: req.auth.sub,
    limit: req.query.limit,
  });

  res.json({
    success: true,
    data: {
      results: deliveries,
      total: deliveries.length,
    },
  });
};

export const uploadParcelPhoto = async (req, res) => {
  const result = await parcelHandover.uploadParcelPhoto({
    userId: req.auth.sub,
    image: req.body?.image ?? req.body?.dataUrl,
  });

  res.status(201).json({ success: true, data: result });
};

export const markParcelVerified = async (req, res) => {
  const handover = await parcelHandover.markParcelVerified({
    deliveryId: req.params.deliveryId,
    driverId: req.auth.sub,
  });

  res.json({ success: true, data: { deliveryId: req.params.deliveryId, handover } });
};

export const verifyPickupOtp = async (req, res) => {
  const handover = await parcelHandover.verifyPickupOtp({
    deliveryId: req.params.deliveryId,
    driverId: req.auth.sub,
    otp: req.body?.otp,
  });

  res.json({ success: true, data: { deliveryId: req.params.deliveryId, handover } });
};

export const verifyDropOtp = async (req, res) => {
  const handover = await parcelHandover.verifyDropOtp({
    deliveryId: req.params.deliveryId,
    driverId: req.auth.sub,
    otp: req.body?.otp,
  });

  res.json({ success: true, data: { deliveryId: req.params.deliveryId, handover } });
};

export const reissueParcelOtp = async (req, res) => {
  const result = await parcelHandover.reissueParcelOtp({
    deliveryId: req.params.deliveryId,
    userId: req.auth.sub,
    kind: req.params.kind,
  });

  res.json({ success: true, data: result });
};

/**
 * Cancel by delivery id. Delegates to the ride cancellation, so reasons,
 * cancellation fees and the driver notification all behave exactly as they do
 * for PATCH /rides/:rideId/cancel.
 */
export const cancelDelivery = async (req, res) => {
  req.params.rideId = await resolveOwnDeliveryRideId({
    deliveryId: req.params.deliveryId,
    userId: req.auth.sub,
  });

  return cancelRide(req, res);
};
