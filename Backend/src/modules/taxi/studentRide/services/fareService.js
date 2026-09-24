import { resolveSetPriceForRide } from '../../services/rideService.js';
import { Vehicle } from '../../admin/models/Vehicle.js';
import { STUDENT_RIDE_ERROR_CODES } from '../constants/index.js';
import { studentRideError } from './studentService.js';
import { vehicleAllowedForStudentRide } from './studentRideSettings.js';
import { STUDENT_RIDE_ERRORS } from '../constants/index.js';

/**
 * Fare for a student ride.
 *
 * Computed on the server from the admin's SetPrice rules rather than accepted
 * from the client. Ordinary taxi rides let the app price the trip and send the
 * number, which is fine when the rider sees and agrees to it on screen; here the
 * person paying is a parent who may not be in the car, so the amount charged
 * should not be whatever the handset claimed.
 */

const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

const haversineKm = (from, to) => {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLng = toRadians(to.longitude - from.longitude);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(dLng / 2) ** 2;

  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Distance for pricing.
 *
 * A client-supplied figure wins when present: it comes from the maps SDK and
 * follows the road. The straight-line fallback is always shorter than the drive,
 * so it under-prices rather than over-prices — the safer direction to be wrong
 * in, and the response says which was used.
 */
export const resolveDistanceMeters = ({ pickup, destination, providedMeters }) => {
  const provided = Number(providedMeters);

  if (Number.isFinite(provided) && provided > 0) {
    return { distanceMeters: Math.round(provided), source: 'client' };
  }

  return {
    distanceMeters: Math.round(haversineKm(pickup, destination) * 1000),
    source: 'straight-line',
  };
};

/**
 * Price a journey.
 *
 * `vehicleTypeId` is required because pricing rules are keyed by it — without
 * one no SetPrice row can be resolved, which is why every student ride booked so
 * far carried a fare of zero.
 */
export const quoteStudentRideFare = async ({
  vehicleTypeId,
  pickup,
  destination,
  serviceLocationId = null,
  zoneId = null,
  distanceMeters = null,
}) => {
  if (!vehicleTypeId) {
    throw studentRideError(
      422,
      STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND,
      'vehicle_type_id is required to price a student ride.',
    );
  }

  const vehicle = await Vehicle.findById(vehicleTypeId)
    .select('name service_tax icon_types category allowed_for_student_ride')
    .lean();

  if (!vehicle) {
    throw studentRideError(
      422,
      STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND,
      'vehicle_type_id does not match a known vehicle type.',
    );
  }

  // Quote and booking both come through here, so this one check covers both.
  if (vehicle && !vehicleAllowedForStudentRide(vehicle)) {
    throw studentRideError(
      422,
      STUDENT_RIDE_ERRORS.VEHICLE_NOT_ALLOWED,
      `${vehicle.name || 'This vehicle type'} cannot be used for student rides.`,
    );
  }

  const pricing = await resolveSetPriceForRide({
    zoneId,
    serviceLocationId,
    // Student rides run on the taxi pricing table; there is no separate student
    // tariff, and inventing one would leave this unpriced until an admin created
    // rows for it.
    transportType: 'taxi',
    vehicleTypeId,
  });

  if (!pricing) {
    throw studentRideError(
      409,
      STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND,
      'No pricing is configured for this vehicle type.',
    );
  }

  const { distanceMeters: resolvedMeters, source } = resolveDistanceMeters({
    pickup,
    destination,
    providedMeters: distanceMeters,
  });

  const distanceKm = resolvedMeters / 1000;
  const basePrice = Math.max(0, Number(pricing.base_price || 0));
  // Distance included in the base fare before per-kilometre charging begins.
  const baseDistanceKm = Math.max(0, Number(pricing.base_distance || 0));
  const pricePerKm = Math.max(0, Number(pricing.price_per_distance || 0));

  const chargeableKm = Math.max(0, distanceKm - baseDistanceKm);
  const distanceCharge = chargeableKm * pricePerKm;
  const subtotal = basePrice + distanceCharge;

  const serviceTaxPercentage = Math.max(0, Number(pricing.service_tax ?? vehicle.service_tax ?? 0));
  const serviceTaxAmount = (subtotal * serviceTaxPercentage) / 100;

  return {
    fare: round2(subtotal + serviceTaxAmount),
    currency: 'INR',
    distanceMeters: resolvedMeters,
    distanceSource: source,
    vehicleTypeId: String(vehicleTypeId),
    vehicleTypeName: vehicle.name || '',
    breakdown: {
      basePrice: round2(basePrice),
      baseDistanceKm: round2(baseDistanceKm),
      chargeableKm: round2(chargeableKm),
      pricePerKm: round2(pricePerKm),
      distanceCharge: round2(distanceCharge),
      subtotal: round2(subtotal),
      serviceTaxPercentage: round2(serviceTaxPercentage),
      serviceTaxAmount: round2(serviceTaxAmount),
    },
  };
};
