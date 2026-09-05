/**
 * Route matching for carpool search (§14).
 *
 * Endpoint equality is not enough: a passenger travelling Dewas → Ujjain must
 * match a host driving Indore → Dewas → Ujjain, and a pickup partway along a leg
 * must match even when it is near no named stop at all.
 *
 * The approach is two-stage. MongoDB narrows candidates with a 2dsphere `$near`
 * against the ride's LineString, which measures distance to the whole corridor
 * rather than to its vertices. Only one `$near` is permitted per query, so the
 * drop side and the ordering rule are evaluated here, against the small
 * candidate set the index already reduced.
 */

const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export const haversineKm = ([lng1, lat1], [lng2, lat2]) => {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;

  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/**
 * Distance from a point to a segment, and how far along that segment the closest
 * approach falls (0 at the start, 1 at the end).
 *
 * Works in a local planar approximation with longitude scaled by cos(latitude).
 * Over the tens of kilometres a carpool leg spans, the error is far below the
 * kilometre-scale tolerances being tested against.
 */
const projectOntoSegment = (point, start, end) => {
  const latRef = toRadians((start[1] + end[1]) / 2);
  const kx = Math.cos(latRef);

  const px = (point[0] - start[0]) * kx;
  const py = point[1] - start[1];
  const vx = (end[0] - start[0]) * kx;
  const vy = end[1] - start[1];

  const lengthSquared = (vx * vx) + (vy * vy);

  if (lengthSquared === 0) {
    return { distanceKm: haversineKm(point, start), t: 0 };
  }

  // Clamped, so a point beyond either end projects to that end rather than off
  // the segment — otherwise a pickup behind the origin would look on-route.
  const t = Math.max(0, Math.min(1, ((px * vx) + (py * vy)) / lengthSquared));
  const closest = [start[0] + (t * (end[0] - start[0])), start[1] + (t * (end[1] - start[1]))];

  return { distanceKm: haversineKm(point, closest), t };
};

/**
 * Closest approach of a point to a polyline.
 *
 * Returns the perpendicular distance and `progressKm` — how far along the route
 * that closest point lies. Comparing progress for pickup and drop is what
 * enforces "pickup occurs before drop in route order" (§14.1 rule 3), which
 * distance alone cannot express: a passenger travelling the route backwards is
 * near it at both ends.
 */
export const closestApproach = (point, path) => {
  if (!Array.isArray(path) || path.length < 2) {
    return { distanceKm: Number.POSITIVE_INFINITY, progressKm: 0 };
  }

  let best = { distanceKm: Number.POSITIVE_INFINITY, progressKm: 0 };
  let travelled = 0;

  for (let index = 0; index < path.length - 1; index += 1) {
    const start = path[index];
    const end = path[index + 1];
    const segmentKm = haversineKm(start, end);
    const { distanceKm, t } = projectOntoSegment(point, start, end);

    if (distanceKm < best.distanceKm) {
      best = { distanceKm, progressKm: travelled + (segmentKm * t) };
    }

    travelled += segmentKm;
  }

  return best;
};

/**
 * Decide whether one candidate ride serves a passenger's pickup and drop.
 *
 * Returns the match detail on success so search results can explain the quality
 * of a match (§46), or null when the ride does not qualify.
 */
export const evaluateRouteMatch = ({
  routeCoordinates,
  pickupPoint,
  dropPoint,
  pickupToleranceKm,
  dropToleranceKm,
}) => {
  const pickup = closestApproach(pickupPoint, routeCoordinates);

  if (pickup.distanceKm > pickupToleranceKm) {
    return null;
  }

  const drop = closestApproach(dropPoint, routeCoordinates);

  if (drop.distanceKm > dropToleranceKm) {
    return null;
  }

  // Direction matters: the drop must lie further along the route than the pickup.
  if (drop.progressKm <= pickup.progressKm) {
    return null;
  }

  return {
    pickupDetourKm: Number(pickup.distanceKm.toFixed(2)),
    dropDetourKm: Number(drop.distanceKm.toFixed(2)),
    sharedDistanceKm: Number((drop.progressKm - pickup.progressKm).toFixed(2)),
  };
};

/**
 * Ranking (§46): closest pickup and drop first, then the earliest departure.
 * Detour is what the passenger actually feels, so it outranks price here.
 */
export const rankMatches = (matches) => [...matches].sort((a, b) => {
  const detourDelta = (a.match.pickupDetourKm + a.match.dropDetourKm)
    - (b.match.pickupDetourKm + b.match.dropDetourKm);

  if (Math.abs(detourDelta) > 0.25) {
    return detourDelta;
  }

  return new Date(a.ride.departureAt).getTime() - new Date(b.ride.departureAt).getTime();
});

/** Origin → ordered stops → destination, as GeoJSON [lng, lat] pairs. */
export const buildRouteCoordinates = ({ origin, stops = [], destination }) => [
  [origin.longitude, origin.latitude],
  ...[...stops]
    .sort((a, b) => a.stopOrder - b.stopOrder)
    .map((stop) => [stop.longitude, stop.latitude]),
  [destination.longitude, destination.latitude],
];
