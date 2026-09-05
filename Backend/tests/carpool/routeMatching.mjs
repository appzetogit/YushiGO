/**
 * Carpool — route matching (§14).
 *
 *   node tests/carpool/routeMatching.mjs
 *
 * Pure geometry, no database. Coordinates are real places on the
 * Indore–Dewas–Ujjain corridor from the specification's own examples.
 */
import {
  buildRouteCoordinates,
  closestApproach,
  evaluateRouteMatch,
  haversineKm,
  rankMatches,
} from '../../src/modules/taxi/carpool/services/routeMatching.js';

let pass = 0;
let fail = 0;

const check = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  FAIL  ${name} -> ${error.message}`);
  }
};

const INDORE = { name: 'Indore', latitude: 22.7196, longitude: 75.8577 };
const VIJAY_NAGAR = { name: 'Vijay Nagar', latitude: 22.7533, longitude: 75.8937 };
const DEWAS = { name: 'Dewas', latitude: 22.9676, longitude: 76.0534 };
const UJJAIN = { name: 'Ujjain', latitude: 23.1765, longitude: 75.7885 };
const BHOPAL = { name: 'Bhopal', latitude: 23.2599, longitude: 77.4126 };

const asPoint = (place) => [place.longitude, place.latitude];

const route = buildRouteCoordinates({
  origin: INDORE,
  stops: [{ ...DEWAS, stopOrder: 1 }],
  destination: UJJAIN,
});

console.log('\nDISTANCE');

check('haversine matches the known Indore–Ujjain distance', () => {
  const km = haversineKm(asPoint(INDORE), asPoint(UJJAIN));
  if (km < 50 || km > 65) throw new Error(`expected ~55km, got ${km.toFixed(1)}`);
});

console.log('\nROUTE CONSTRUCTION');

check('route runs origin, stops in order, destination', () => {
  if (route.length !== 3) throw new Error(`expected 3 points, got ${route.length}`);
  if (route[1][0] !== DEWAS.longitude) throw new Error('stop not in the middle');
});

check('stops are ordered by stopOrder, not array order', () => {
  const built = buildRouteCoordinates({
    origin: INDORE,
    stops: [{ ...UJJAIN, stopOrder: 2 }, { ...DEWAS, stopOrder: 1 }],
    destination: BHOPAL,
  });
  if (built[1][0] !== DEWAS.longitude) throw new Error('stops were not sorted');
});

console.log('\nMATCHING (spec §14 examples)');

check('Dewas -> Ujjain matches a host driving Indore -> Dewas -> Ujjain', () => {
  const match = evaluateRouteMatch({
    routeCoordinates: route,
    pickupPoint: asPoint(DEWAS),
    dropPoint: asPoint(UJJAIN),
    pickupToleranceKm: 3,
    dropToleranceKm: 3,
  });
  if (!match) throw new Error('should match');
  if (match.sharedDistanceKm <= 0) throw new Error('shared distance should be positive');
});

check('Vijay Nagar -> Ujjain matches: pickup is near the corridor, not a stop', () => {
  const toNearestVertex = Math.min(
    haversineKm(asPoint(VIJAY_NAGAR), asPoint(INDORE)),
    haversineKm(asPoint(VIJAY_NAGAR), asPoint(DEWAS)),
    haversineKm(asPoint(VIJAY_NAGAR), asPoint(UJJAIN)),
  );
  const toCorridor = closestApproach(asPoint(VIJAY_NAGAR), route).distanceKm;

  // The point of corridor matching: closer to the line than to any vertex.
  if (toCorridor >= toNearestVertex) {
    throw new Error(`corridor ${toCorridor.toFixed(2)}km should beat vertex ${toNearestVertex.toFixed(2)}km`);
  }

  const match = evaluateRouteMatch({
    routeCoordinates: route,
    pickupPoint: asPoint(VIJAY_NAGAR),
    dropPoint: asPoint(UJJAIN),
    pickupToleranceKm: 5,
    dropToleranceKm: 3,
  });
  if (!match) throw new Error('should match');
});

console.log('\nREJECTIONS');

check('a passenger travelling the route backwards is rejected', () => {
  const match = evaluateRouteMatch({
    routeCoordinates: route,
    pickupPoint: asPoint(UJJAIN),
    dropPoint: asPoint(DEWAS),
    pickupToleranceKm: 3,
    dropToleranceKm: 3,
  });
  // Both endpoints sit on the route; only ordering can reject this.
  if (match) throw new Error('reverse direction should not match');
});

check('a drop far off the corridor is rejected', () => {
  const match = evaluateRouteMatch({
    routeCoordinates: route,
    pickupPoint: asPoint(INDORE),
    dropPoint: asPoint(BHOPAL),
    pickupToleranceKm: 3,
    dropToleranceKm: 3,
  });
  if (match) throw new Error('Bhopal is ~150km off route');
});

check('a pickup far off the corridor is rejected', () => {
  const match = evaluateRouteMatch({
    routeCoordinates: route,
    pickupPoint: asPoint(BHOPAL),
    dropPoint: asPoint(UJJAIN),
    pickupToleranceKm: 3,
    dropToleranceKm: 3,
  });
  if (match) throw new Error('should not match');
});

check('a point behind the origin does not project onto the first segment', () => {
  // West of Indore, away from the route's direction of travel.
  const behind = [75.5, 22.65];
  const { progressKm } = closestApproach(behind, route);
  if (progressKm > 1) throw new Error(`should clamp to the start, got ${progressKm.toFixed(2)}km`);
});

check('tolerance is what decides a borderline pickup', () => {
  const args = {
    routeCoordinates: route,
    pickupPoint: asPoint(VIJAY_NAGAR),
    dropPoint: asPoint(UJJAIN),
    dropToleranceKm: 3,
  };
  const tight = evaluateRouteMatch({ ...args, pickupToleranceKm: 0.05 });
  const loose = evaluateRouteMatch({ ...args, pickupToleranceKm: 5 });

  if (tight) throw new Error('should be rejected at 50m tolerance');
  if (!loose) throw new Error('should be accepted at 5km tolerance');
});

console.log('\nRANKING');

check('smaller total detour ranks first', () => {
  const ranked = rankMatches([
    { ride: { departureAt: '2026-09-06T10:00:00Z' }, match: { pickupDetourKm: 4, dropDetourKm: 3 } },
    { ride: { departureAt: '2026-09-06T11:00:00Z' }, match: { pickupDetourKm: 0.2, dropDetourKm: 0.3 } },
  ]);
  if (ranked[0].match.pickupDetourKm !== 0.2) throw new Error('closer ride should rank first');
});

check('equal detour falls back to the earlier departure', () => {
  const ranked = rankMatches([
    { ride: { departureAt: '2026-09-06T18:00:00Z' }, match: { pickupDetourKm: 1, dropDetourKm: 1 } },
    { ride: { departureAt: '2026-09-06T09:00:00Z' }, match: { pickupDetourKm: 1, dropDetourKm: 1 } },
  ]);
  if (!ranked[0].ride.departureAt.startsWith('2026-09-06T09')) {
    throw new Error('earlier departure should rank first');
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
