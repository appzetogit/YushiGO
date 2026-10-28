/**
 * Search a Driver — fare arithmetic (spec §7).
 *
 *   node tests/driverHire/pricing.mjs
 *
 * buildFare and cancellationFeeFor are pure, so no database is needed.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
process.env.DRIVER_HIRE_TIMEZONE = 'Asia/Kolkata';

const { buildFare, cancellationFeeFor } = await import('../../src/modules/taxi/driverHire/services/pricingService.js');

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

const eq = (actual, expected, label = '') => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const terms = (overrides = {}) => ({
  serviceType: 'SCHEDULED',
  currency: 'INR',
  baseFare: 300,
  includedMinutes: 60,
  minimumMinutes: 120,
  extraBlockMinutes: 60,
  extraBlockFare: 100,
  freeWaitingMinutes: 15,
  waitingPerMinute: 2,
  nightCharge: 150,
  nightStartHour: 22,
  nightEndHour: 6,
  dailyAllowance: 0,
  overnightAllowance: 0,
  oneWayReturnFare: 0,
  bookingFee: 20,
  taxPercent: 5,
  platformCommissionPercent: 20,
  freeCancelMinutes: 5,
  freeCancelBeforePickupMinutes: 60,
  cancellationFee: 50,
  lateCancellationFee: 100,
  noShowWaitMinutes: 30,
  noShowFee: 150,
  allowDriverExpenses: true,
  eventPackages: [],
  ...overrides,
});

// 10:00 IST — not a night pickup.
const DAY = new Date('2026-11-02T04:30:00Z');
// 23:30 IST.
const NIGHT = new Date('2026-11-02T18:00:00Z');
const codes = (fare) => fare.lines.map((line) => line.code);

console.log('Search a Driver — pricing');

check('3h scheduled: base + 2 blocks, booking fee, tax, split', () => {
  const fare = buildFare(terms(), { serviceType: 'SCHEDULED', durationMinutes: 180, scheduledAt: DAY });
  eq(codes(fare), ['BASE', 'EXTRA_TIME', 'BOOKING_FEE']);
  eq(fare.subtotal, 520, 'subtotal');
  eq(fare.tax, 26, 'tax');
  eq(fare.total, 546, 'total');
  eq(fare.platformFee, 120, 'platform fee (20% of 500 + 20 booking fee)');
  eq(fare.driverAmount, 400, 'driver amount');
});

check('minimum duration is billed even for a shorter trip', () => {
  const fare = buildFare(terms(), { serviceType: 'SCHEDULED', durationMinutes: 45, scheduledAt: DAY });
  eq(fare.lines.find((line) => line.code === 'EXTRA_TIME').amount, 100);
});

check('partial block rounds up', () => {
  const fare = buildFare(terms({ minimumMinutes: 0 }), { serviceType: 'HOURLY', durationMinutes: 61, scheduledAt: DAY });
  eq(fare.lines.find((line) => line.code === 'EXTRA_TIME').amount, 100);
});

check('night pickup adds the night charge (IST)', () => {
  const fare = buildFare(terms(), { serviceType: 'SCHEDULED', durationMinutes: 120, scheduledAt: NIGHT });
  eq(codes(fare).includes('NIGHT'), true);
});

check('waiting beyond the free minutes is charged per minute', () => {
  const fare = buildFare(terms(), { serviceType: 'SCHEDULED', durationMinutes: 120, scheduledAt: DAY, waitingMinutes: 25 });
  eq(fare.lines.find((line) => line.code === 'WAITING').amount, 20);
});

check('final fare over the booked time is labelled overtime', () => {
  const fare = buildFare(terms(), { serviceType: 'SCHEDULED', durationMinutes: 200, bookedMinutes: 120, isFinal: true, scheduledAt: DAY });
  eq(codes(fare).includes('OVERTIME'), true);
});

check('expenses pass through: no tax, no commission, all to the driver', () => {
  const base = buildFare(terms(), { serviceType: 'SCHEDULED', durationMinutes: 120, scheduledAt: DAY });
  const fare = buildFare(terms(), {
    serviceType: 'SCHEDULED',
    durationMinutes: 120,
    scheduledAt: DAY,
    expenses: [{ kind: 'TOLL', amount: 75, note: 'Expressway' }, { kind: 'PARKING', amount: 40 }],
  });
  eq(fare.tax, base.tax, 'tax unchanged');
  eq(fare.platformFee, base.platformFee, 'platform fee unchanged');
  eq(fare.total, base.total + 115, 'total');
  eq(fare.driverAmount, base.driverAmount + 115, 'driver amount');
  eq(fare.lines.find((line) => line.code === 'EXPENSE_TOLL').label, 'Toll: Expressway');
});

check('outstation round trip: days, nights, no return fare', () => {
  const fare = buildFare(
    terms({ serviceType: 'OUTSTATION', dailyAllowance: 200, overnightAllowance: 300, oneWayReturnFare: 500, minimumMinutes: 0, includedMinutes: 1440, extraBlockMinutes: 1440, extraBlockFare: 1000 }),
    { serviceType: 'OUTSTATION', durationMinutes: 3 * 1440, nights: 2, outstationTripType: 'ROUND_TRIP', scheduledAt: DAY },
  );
  eq(fare.lines.find((line) => line.code === 'DAILY_ALLOWANCE').amount, 600);
  eq(fare.lines.find((line) => line.code === 'OVERNIGHT').amount, 600);
  eq(codes(fare).includes('RETURN_TRAVEL'), false);
});

check('outstation one way adds the driver return fare', () => {
  const fare = buildFare(
    terms({ serviceType: 'OUTSTATION', oneWayReturnFare: 500 }),
    { serviceType: 'OUTSTATION', durationMinutes: 1440, nights: 0, outstationTripType: 'ONE_WAY', scheduledAt: DAY },
  );
  eq(fare.lines.find((line) => line.code === 'RETURN_TRAVEL').amount, 500);
});

check('event package price, then overtime beyond the package', () => {
  const pkg = { code: 'WED6', name: 'Wedding 6h', minutes: 360, price: 2500 };
  const t = terms({ serviceType: 'EVENT', eventPackage: pkg });
  const quoted = buildFare(t, { serviceType: 'EVENT', durationMinutes: 360, eventPackage: pkg, scheduledAt: DAY });
  eq(codes(quoted), ['EVENT_PACKAGE', 'BOOKING_FEE']);
  const final = buildFare(t, { serviceType: 'EVENT', durationMinutes: 400, eventPackage: pkg, scheduledAt: DAY, isFinal: true });
  eq(final.lines.find((line) => line.code === 'OVERTIME').amount, 100);
});

console.log('Search a Driver — cancellation fees');

const booking = (status, { assignedMinutesAgo = 0, pickupInMinutes = 30 } = {}) => ({
  status,
  assignedAt: new Date(Date.now() - assignedMinutesAgo * 60000),
  scheduledAt: new Date(Date.now() + pickupInMinutes * 60000),
  fare: { terms: terms() },
});

check('free before a driver is assigned', () => eq(cancellationFeeFor(booking('REQUESTED')), 0));
check('free inside the grace window after assignment', () => eq(cancellationFeeFor(booking('DRIVER_ASSIGNED', { assignedMinutesAgo: 2 })), 0));
check('free while pickup is still well ahead', () => eq(cancellationFeeFor(booking('DRIVER_ASSIGNED', { assignedMinutesAgo: 30, pickupInMinutes: 180 })), 0));
check('fee once assigned and pickup is close', () => eq(cancellationFeeFor(booking('DRIVER_ASSIGNED', { assignedMinutesAgo: 30 })), 50));
check('late fee once the driver is on the way', () => eq(cancellationFeeFor(booking('DRIVER_EN_ROUTE')), 100));
check('late fee after arrival', () => eq(cancellationFeeFor(booking('DRIVER_ARRIVED')), 100));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
