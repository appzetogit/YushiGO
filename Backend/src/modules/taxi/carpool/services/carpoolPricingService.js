import { AdminBusinessSetting } from '../../admin/models/AdminBusinessSetting.js';
import { carpoolConfig } from '../constants/index.js';
import { haversineKm } from './routeMatching.js';

/**
 * Carpool price ceiling: admin rate per km × route distance.
 *
 * Carpooling is cost sharing, so a host may not charge more per seat than the
 * trip reasonably costs. Until an admin sets `carpool.rate_per_km` (business
 * settings, category "carpool") the old flat CARPOOL_MAX_PRICE_PER_SEAT still
 * applies, so publishing behaves exactly as before.
 */

const DIRECTIONS_TIMEOUT_MS = 8000;

export const getCarpoolSettings = async () => {
  const doc = await AdminBusinessSetting.findOne({ scope: 'default' }).select('carpool').lean();
  const raw = doc?.carpool || {};
  const rate = Number(raw.rate_per_km);
  const detour = Number(raw.door_to_door_max_detour_km);

  return {
    ratePerKm: Number.isFinite(rate) && rate > 0 ? rate : null,
    doorToDoorMaxDetourKm: Number.isFinite(detour) && detour > 0 ? detour : 10,
  };
};

const straightLineKm = (coordinates = []) => {
  let total = 0;

  for (let i = 1; i < coordinates.length; i += 1) {
    total += haversineKm(coordinates[i - 1], coordinates[i]);
  }

  return total;
};

const googleKey = async () => {
  const { AdminThirdPartySetting } = await import('../../admin/models/AdminThirdPartySetting.js');
  const doc = await AdminThirdPartySetting.findOne({ scope: 'default' }).select('map_apis').lean();
  return String(doc?.map_apis?.google_map_key_for_distance_matrix || '').trim();
};

/** Driving distance through the route's points, from Google Directions. null on any failure. */
const googleRouteKm = async (coordinates, key) => {
  const asLatLng = ([lng, lat]) => `${lat},${lng}`;
  const origin = asLatLng(coordinates[0]);
  const destination = asLatLng(coordinates[coordinates.length - 1]);
  const waypoints = coordinates.slice(1, -1).map(asLatLng).join('|');

  const params = new URLSearchParams({ origin, destination, key });
  if (waypoints) params.set('waypoints', waypoints);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECTIONS_TIMEOUT_MS);

  try {
    const response = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`, { signal: controller.signal });
    const json = await response.json();

    if (json?.status !== 'OK' || !json.routes?.[0]?.legs?.length) {
      console.warn('[carpool] directions lookup failed', json?.status || response.status);
      return null;
    }

    const meters = json.routes[0].legs.reduce((sum, leg) => sum + Number(leg.distance?.value || 0), 0);
    return meters > 0 ? meters / 1000 : null;
  } catch (error) {
    console.warn('[carpool] directions lookup failed', error?.name || 'error');
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Route distance in km for [[lng, lat], ...]. Google driving distance when a
 * key is configured, else the straight-line length along the route's points —
 * `source` says which, so the app can say "approx.".
 */
export const routeDistanceKm = async (coordinates = []) => {
  if (coordinates.length < 2) {
    return { distanceKm: 0, source: 'none' };
  }

  const key = await googleKey();

  if (key) {
    const km = await googleRouteKm(coordinates, key);

    if (km) {
      return { distanceKm: Math.round(km * 100) / 100, source: 'google_directions' };
    }
  }

  return { distanceKm: Math.round(straightLineKm(coordinates) * 100) / 100, source: 'straight_line' };
};

/** The most a host may charge per seat for a route of this length. */
export const priceLimitFor = async (coordinates) => {
  const [{ ratePerKm }, distance] = await Promise.all([getCarpoolSettings(), routeDistanceKm(coordinates)]);

  if (!ratePerKm) {
    return {
      ...distance,
      ratePerKm: null,
      maxPrice: carpoolConfig().maxPricePerSeat,
      basis: 'flat_limit',
    };
  }

  return {
    ...distance,
    ratePerKm,
    // Whole rupees, and never below 1 so a very short hop can still be priced.
    maxPrice: Math.max(1, Math.round(ratePerKm * distance.distanceKm)),
    basis: 'rate_per_km',
  };
};
