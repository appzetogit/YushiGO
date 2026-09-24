import mongoose from 'mongoose';
import { ApiError } from '../../../../utils/ApiError.js';
import { normalizePoint } from '../../../../utils/geo.js';
import { GoodsType } from '../../admin/models/GoodsType.js';
import { Vehicle } from '../../admin/models/Vehicle.js';
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
import { PARCEL_SIZES, parcelConfig, parcelSizeRank, parseWeightKg } from './parcelPolicy.js';
import { currentSenderCode, loadDeliveryHandover, serializeHandover } from './parcelHandoverService.js';

const ensureParcelRide = (ride) => {
  if (!ride || String(ride.serviceType || ride.type || 'ride').toLowerCase() !== 'parcel') {
    throw new ApiError(404, 'Delivery not found');
  }

  return ride;
};

const normalizeVehicleLabel = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

const getVehicleTokens = (vehicle = {}) =>
  [
    vehicle?.name,
    vehicle?.vehicle_type,
    vehicle?.icon_types,
    String(vehicle?.name || '').replace(/\s+/g, '_'),
  ]
    .map(normalizeVehicleLabel)
    .filter(Boolean);

const goodsTypeAllowsVehicle = (goodsType, vehicle) => {
  const allowedLabels = String(goodsType?.goods_types_for || goodsType?.goods_type_for || 'both')
    .split(',')
    .map(normalizeVehicleLabel)
    .filter(Boolean);

  if (!allowedLabels.length || allowedLabels.includes('both') || allowedLabels.includes('all')) {
    return true;
  }

  const tokens = getVehicleTokens(vehicle);
  return allowedLabels.some((label) => tokens.some((token) => token.includes(label) || label.includes(token)));
};

const ensureDeliveryVehicleAllowed = async ({ vehicleTypeId, parcel }) => {
  const category = String(parcel?.category || '').trim();

  if (!vehicleTypeId || !category) {
    return;
  }

  const [goodsType, vehicle] = await Promise.all([
    GoodsType.findOne({
      goods_type_name: { $regex: `^${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      active: 1,
    })
      .select('goods_type_name goods_types_for goods_type_for')
      .lean(),
    Vehicle.findById(vehicleTypeId).select('name vehicle_type icon_types').lean(),
  ]);

  if (!goodsType || !vehicle) {
    return;
  }

  if (!goodsTypeAllowsVehicle(goodsType, vehicle)) {
    throw new ApiError(400, `${goodsType.goods_type_name || category} is not allowed for the selected vehicle type`);
  }
};

const parcelInputError = (message, code = 'INVALID_PARCEL') => {
  const error = new ApiError(422, message);
  error.code = code;
  return error;
};

/** 10-digit Indian mobile from "+91 98765 43210", "09876543210", "9876543210"; '' if not one. */
const normalizeMobile = (value) => {
  let digits = String(value || '').replace(/\D/g, '');

  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  return /^[6-9]\d{9}$/.test(digits) ? digits : '';
};

/** A custom box is classed by its longest side, so it can be matched to a vehicle like any other size. */
const sizeClassFor = (parcel) => {
  if (parcel.size !== 'custom') {
    return parcel.size;
  }

  const longest = Math.max(
    Number(parcel.customSize?.length) || 0,
    Number(parcel.customSize?.width) || 0,
    Number(parcel.customSize?.height) || 0,
  );

  if (longest <= 40) return 'small';
  if (longest <= 80) return 'medium';
  if (longest <= 150) return 'large';
  return 'custom';
};

/**
 * Validate and normalize the parcel block of a quote or booking.
 *
 * New fields are always checked when sent. They are required — photo, size,
 * weight, both names and valid 10-digit mobiles — only with
 * PARCEL_OTP_ENFORCED, so the current app, which sends none of them, keeps
 * booking until the new one ships.
 */
export const normalizeParcelInput = (parcel = {}, { forBooking = false } = {}) => {
  const config = parcelConfig();
  const strict = forBooking && config.enforced;
  const normalized = { ...(parcel || {}) };

  const weight = parseWeightKg(parcel?.weight);

  if (weight !== null && (weight <= 0 || weight > config.maxWeightKg)) {
    throw parcelInputError(`parcel.weight must be more than 0 and at most ${config.maxWeightKg} kg.`);
  }

  if (strict && weight === null) {
    throw parcelInputError('parcel.weight (kg) is required.');
  }

  normalized.weight = weight;

  const size = String(parcel?.size || '').trim().toLowerCase();

  if (size && !PARCEL_SIZES.includes(size)) {
    throw parcelInputError(`parcel.size must be one of ${PARCEL_SIZES.join(', ')}.`);
  }

  if (strict && !size) {
    throw parcelInputError('parcel.size is required.');
  }

  normalized.size = size;

  if (size === 'custom') {
    const custom = parcel?.customSize || parcel?.custom_size || {};
    const dims = ['length', 'width', 'height'].map((key) => Number(custom[key]));

    if (!dims.every((value) => Number.isFinite(value) && value > 0 && value <= config.maxDimensionCm)) {
      throw parcelInputError(`parcel.customSize needs length, width and height in cm, each up to ${config.maxDimensionCm}.`);
    }

    normalized.customSize = { length: dims[0], width: dims[1], height: dims[2] };
  }

  const photoUrl = String(parcel?.photoUrl || parcel?.photo_url || '').trim();

  if (photoUrl && !/^(https?:\/\/|\/uploads\/)/i.test(photoUrl)) {
    throw parcelInputError('parcel.photoUrl must be the URL returned by /deliveries/upload-photo.');
  }

  if (strict && !photoUrl) {
    throw parcelInputError('parcel.photoUrl is required. Upload the photo first.');
  }

  normalized.photoUrl = photoUrl;

  if (strict) {
    for (const [nameKey, mobileKey, label] of [
      ['senderName', 'senderMobile', 'sender'],
      ['receiverName', 'receiverMobile', 'receiver'],
    ]) {
      if (!String(parcel?.[nameKey] || '').trim()) {
        throw parcelInputError(`parcel.${nameKey} is required.`);
      }

      const mobile = normalizeMobile(parcel?.[mobileKey]);

      if (!mobile) {
        throw parcelInputError(`parcel.${mobileKey} must be a valid 10-digit mobile number for the ${label}.`);
      }

      normalized[mobileKey] = mobile;
    }
  }

  return normalized;
};

/** Whether a vehicle type's parcel limits admit this parcel. No limits set means yes. */
export const vehicleCanCarryParcel = (vehicle, parcel) => {
  const limits = vehicle?.parcel_limits || {};
  const maxWeight = Number(limits.max_weight_kg);

  if (Number.isFinite(maxWeight) && maxWeight > 0 && parcel?.weight !== null && parcel?.weight !== undefined
    && Number(parcel.weight) > maxWeight) {
    return false;
  }

  const sizeClass = parcel?.size ? sizeClassFor(parcel) : '';

  if (limits.max_size && sizeClass && parcelSizeRank(sizeClass) > parcelSizeRank(limits.max_size)) {
    return false;
  }

  return true;
};

const describesParcel = (parcel) =>
  (parcel?.weight !== null && parcel?.weight !== undefined) || Boolean(parcel?.size);

/** Delivery vehicle types that can take this parcel, for the quote screen. */
const suitableVehicleTypes = async (parcel) => {
  const vehicles = await Vehicle.find({ transport_type: { $in: ['delivery', 'both'] }, status: 1 })
    .select('name icon_types image map_icon parcel_limits')
    .lean();

  return vehicles
    .filter((vehicle) => vehicleCanCarryParcel(vehicle, parcel))
    .map((vehicle) => ({
      vehicleTypeId: String(vehicle._id),
      name: vehicle.name,
      iconType: vehicle.icon_types || '',
      icon: vehicle.map_icon || vehicle.image || '',
      maxWeightKg: vehicle.parcel_limits?.max_weight_kg ?? null,
      maxSize: vehicle.parcel_limits?.max_size || null,
    }));
};

const assertVehicleFitsParcel = async ({ vehicleTypeId, parcel }) => {
  if (!vehicleTypeId || !describesParcel(parcel)) {
    return;
  }

  const vehicle = await Vehicle.findById(vehicleTypeId).select('name parcel_limits').lean();

  if (vehicle && !vehicleCanCarryParcel(vehicle, parcel)) {
    const error = new ApiError(422, `${vehicle.name || 'This vehicle'} cannot carry a parcel of this size or weight.`);
    error.code = 'PARCEL_VEHICLE_UNSUITABLE';
    throw error;
  }
};

const roundCurrency = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const toRadians = (value) => (Number(value) * Math.PI) / 180;

const calculateDistanceKm = (fromCoords = [], toCoords = []) => {
  if (!Array.isArray(fromCoords) || !Array.isArray(toCoords) || fromCoords.length < 2 || toCoords.length < 2) {
    return 0;
  }

  const [fromLng, fromLat] = fromCoords.map(Number);
  const [toLng, toLat] = toCoords.map(Number);
  if (![fromLng, fromLat, toLng, toLat].every(Number.isFinite)) {
    return 0;
  }

  const earthRadiusKm = 6371;
  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const lat1 = toRadians(fromLat);
  const lat2 = toRadians(toLat);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);

  return earthRadiusKm * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

const computeDeliveryFareBreakdown = ({ vehicle = {}, pickupCoords = [], dropCoords = [] }) => {
  const pricing = vehicle?.delivery_distance_pricing || {};
  const enabled = Boolean(
    pricing?.enabled ||
    Number(pricing?.base_price || 0) > 0 ||
    Number(pricing?.distance_price || 0) > 0
  );

  if (!enabled) {
    return {
      total: 0,
      subtotal: 0,
      serviceTaxPercentage: Math.max(0, Number(vehicle?.service_tax || 0)),
      serviceTaxAmount: 0,
    };
  }

  const distanceKm = Math.max(0, calculateDistanceKm(pickupCoords, dropCoords));
  const basePrice = Math.max(0, Number(pricing?.base_price || 0));
  const baseDistance = Math.max(0, Number(pricing?.base_distance ?? pricing?.free_distance ?? 0));
  const distancePrice = Math.max(0, Number(pricing?.distance_price || 0));
  const extraDistanceKm = Math.max(distanceKm - baseDistance, 0);
  const distanceCharge = extraDistanceKm * distancePrice;
  const subtotal = basePrice + distanceCharge;
  const serviceTaxPercentage = Math.max(0, Number(vehicle?.service_tax || 0));
  const serviceTaxAmount = (subtotal * serviceTaxPercentage) / 100;

  return {
    total: roundCurrency(subtotal + serviceTaxAmount),
    subtotal: roundCurrency(subtotal),
    serviceTaxPercentage: roundCurrency(serviceTaxPercentage),
    serviceTaxAmount: roundCurrency(serviceTaxAmount),
  };
};

export const serializeDeliveryRealtime = (ride) => {
  const serializedRide = serializeRideRealtime(ride);

  return {
    ...serializedRide,
    deliveryId: ride.deliveryId?._id ? String(ride.deliveryId._id) : ride.deliveryId ? String(ride.deliveryId) : null,
    rideId: String(ride._id),
    room: getRideRoom(ride._id),
    type: 'parcel',
    serviceType: 'parcel',
  };
};

/**
 * The delivery as a given participant may see it: the ride payload plus the
 * handover progress. The sender also gets the live codes, and — only once the
 * parcel contract is enforced — `otp` becomes the code they should be showing,
 * so an app reading the generic `otp` field shows the right one.
 */
export const serializeDeliveryForViewer = async (ride, { role }) => {
  const base = serializeDeliveryRealtime(ride);
  const delivery = await loadDeliveryHandover(base.deliveryId);
  const handover = serializeHandover(delivery, { viewerRole: role === 'user' ? 'user' : 'driver' });

  const result = { ...base, handover };

  if (role === 'user' && handover.enforced) {
    result.otp = currentSenderCode(handover);
  }

  return result;
};

/**
 * Price a delivery without creating one. Uses exactly the same vehicle lookup and
 * fare maths as createDeliveryRecord, so a quote and the fare charged on booking
 * cannot drift apart.
 */
export const quoteDelivery = async ({ pickup, drop, vehicleTypeId, parcel: rawParcel }) => {
  const parcel = normalizeParcelInput(rawParcel);
  await ensureDeliveryVehicleAllowed({ vehicleTypeId, parcel });

  const pickupCoords = normalizePoint(pickup, 'pickup');
  const dropCoords = normalizePoint(drop, 'drop');
  const vehicle = vehicleTypeId
    ? await Vehicle.findById(vehicleTypeId).select('delivery_distance_pricing service_tax').lean()
    : null;

  const fareBreakdown = computeDeliveryFareBreakdown({ vehicle, pickupCoords, dropCoords });

  return {
    vehicleTypeId: vehicleTypeId ? String(vehicleTypeId) : null,
    distanceKm: roundCurrency(calculateDistanceKm(pickupCoords, dropCoords)),
    // Zero when this vehicle has no delivery pricing configured — the client then
    // has to collect a fare itself, same as createDeliveryRecord falls back to doing.
    priced: fareBreakdown.total > 0,
    fare: fareBreakdown.total,
    breakdown: fareBreakdown,
    // Only when the parcel is described; otherwise every vehicle qualifies and
    // the list would say nothing.
    ...(describesParcel(parcel)
      ? {
          vehicleFits: vehicleTypeId
            ? vehicleCanCarryParcel(
                await Vehicle.findById(vehicleTypeId).select('parcel_limits').lean(),
                parcel,
              )
            : null,
          suitableVehicleTypes: await suitableVehicleTypes(parcel),
        }
      : {}),
  };
};

export const createDeliveryRecord = async ({
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
  parcel: rawParcel,
}) => {
  const parcel = normalizeParcelInput(rawParcel, { forBooking: true });
  await ensureDeliveryVehicleAllowed({ vehicleTypeId, parcel });
  await assertVehicleFitsParcel({ vehicleTypeId, parcel });
  const pickupCoords = normalizePoint(pickup, 'pickup');
  const dropCoords = normalizePoint(drop, 'drop');
  const vehicle = vehicleTypeId
    ? await Vehicle.findById(vehicleTypeId).select('delivery_distance_pricing service_tax').lean()
    : null;
  const fareBreakdown = computeDeliveryFareBreakdown({ vehicle, pickupCoords, dropCoords });
  const resolvedFare = fareBreakdown.total > 0 ? fareBreakdown.total : Number(fare || 0);

  const ride = await createRideRecord({
    userId,
    pickupCoords,
    dropCoords,
    pickupAddress,
    dropAddress,
    fare: resolvedFare,
    vehicleTypeId,
    vehicleTypeIds,
    vehicleIconType,
    vehicleIconUrl,
    paymentMethod,
    transport_type: 'delivery',
    serviceType: 'parcel',
    parcel,
  });

  await startDispatchFlow(ride);

  const detailedRide = await getRideDetails(ride._id);
  return serializeDeliveryForViewer(ensureParcelRide(detailedRide), { role: 'user' });
};

export const getActiveDeliveryForIdentity = async ({ role, entityId }) => {
  const ride = await getActiveRideForIdentity({ role, entityId });

  if (!ride) {
    return null;
  }

  if (String(ride.serviceType || ride.type || 'ride').toLowerCase() !== 'parcel') {
    return null;
  }

  return serializeDeliveryForViewer(ride, { role });
};

export const getDeliveryById = async ({ deliveryId, role, entityId }) => {
  const delivery = await Delivery.findById(deliveryId).select('rideId');

  if (!delivery?.rideId) {
    throw new ApiError(404, 'Delivery not found');
  }

  await ensureRideParticipantAccess({ rideId: delivery.rideId, role, entityId });
  const ride = await getRideDetails(delivery.rideId);
  return serializeDeliveryForViewer(ensureParcelRide(ride), { role });
};

/** The user's own delivery → its ride id, for delegating to the ride endpoints. */
export const resolveOwnDeliveryRideId = async ({ deliveryId, userId }) => {
  const delivery = mongoose.Types.ObjectId.isValid(String(deliveryId || ''))
    ? await Delivery.findById(deliveryId).select('rideId userId').lean()
    : null;

  if (!delivery?.rideId || String(delivery.userId) !== String(userId)) {
    throw new ApiError(404, 'Delivery not found');
  }

  return String(delivery.rideId);
};

export const listDeliveriesForIdentity = async ({ role, entityId, limit }) => {
  const rides = await listRideHistoryForIdentity({ role, entityId, limit });
  return rides
    .filter((ride) => String(ride.serviceType || ride.type || 'ride').toLowerCase() === 'parcel')
    .map((ride) => ({
      ...ride,
      type: 'parcel',
      serviceType: 'parcel',
    }));
};
