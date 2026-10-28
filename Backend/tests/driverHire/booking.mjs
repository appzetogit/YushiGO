/**
 * Search a Driver — booking lifecycle, concurrency, eligibility and privacy.
 *
 *   node tests/driverHire/booking.mjs
 *
 * Uses a throwaway database on a replica set (transactions). Races are fired
 * genuinely in parallel: a read-then-write implementation passes a sequential
 * test and still double-assigns in production.
 */
import mongoose from 'mongoose';

const DB_NAME = `driver_hire_test_${Date.now()}`;
process.env.MONGODB_URI = process.env.DRIVER_HIRE_TEST_URI
  ? process.env.DRIVER_HIRE_TEST_URI.replace(/\/(\?|$)/, `/${DB_NAME}$1`)
  : `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
process.env.DRIVER_HIRE_SWEEP_ENABLED = 'false';

const bookingService = await import('../../src/modules/taxi/driverHire/services/bookingService.js');
const lifecycle = await import('../../src/modules/taxi/driverHire/services/lifecycleService.js');
const vehicleService = await import('../../src/modules/taxi/driverHire/services/vehicleService.js');
const pricingService = await import('../../src/modules/taxi/driverHire/services/pricingService.js');
const profileService = await import('../../src/modules/taxi/driverHire/services/profileService.js');
const feedback = await import('../../src/modules/taxi/driverHire/services/feedbackService.js');
const adminService = await import('../../src/modules/taxi/driverHire/services/adminService.js');
const sweep = await import('../../src/modules/taxi/driverHire/services/sweepService.js');
const { DriverHireBooking } = await import('../../src/modules/taxi/driverHire/models/DriverHireBooking.js');
const { DriverHireProfile } = await import('../../src/modules/taxi/driverHire/models/DriverHireProfile.js');
const { DriverHirePayment, DriverHireAuditLog } = await import('../../src/modules/taxi/driverHire/models/DriverHireRecords.js');
const { DRIVER_HIRE_AGREEMENT_VERSION } = await import('../../src/modules/taxi/driverHire/constants/index.js');

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

for (const name of [
  'TaxiDriverHireProfile', 'TaxiDriverHireVehicle', 'TaxiDriverHirePricing', 'TaxiDriverHireQuote',
  'TaxiDriverHireBooking', 'TaxiDriverHirePayment', 'TaxiDriverHireReview', 'TaxiDriverHireSupportCase',
  'TaxiDriverHireAuditLog',
]) {
  await mongoose.model(name).createCollection();
  // Unique indexes carry the idempotency and one-current-pricing guarantees.
  await mongoose.model(name).syncIndexes();
}

let pass = 0;
let fail = 0;

const check = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  FAIL  ${name} -> ${error.message}`);
  }
};

const expectReject = async (name, code, fn) => {
  await check(name, async () => {
    try {
      await fn();
    } catch (error) {
      if (error.code !== code) throw new Error(`expected ${code}, got ${error.code} (${error.message})`);
      return;
    }
    throw new Error('expected rejection, call succeeded');
  });
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

// ── Fixtures ────────────────────────────────────────────────────────────────

const oid = () => new mongoose.Types.ObjectId();
const customer = oid();
const otherCustomer = oid();
const admin = oid();
const drivers = { anil: oid(), bina: oid(), chet: oid(), manualOnly: oid(), expired: oid(), offline: oid() };

await mongoose.connection.collection('taxiusers').insertMany([
  { _id: customer, name: 'Riya Kapoor', phone: '9000000001' },
  { _id: otherCustomer, name: 'Someone Else', phone: '9000000002' },
]);
await mongoose.connection.collection('taxidrivers').insertMany(
  Object.entries(drivers).map(([name, _id], index) => ({
    _id, name: `${name} Driver`, phone: `98000000${index}`, approve: true, status: 'approved', deletedAt: null, rating: 4.2,
  })),
);

const inYears = (years) => new Date(Date.now() + years * 365 * 86400000);
const profile = (driverId, overrides = {}) => ({
  driverId,
  verificationStatus: 'APPROVED',
  licenceNumberEncrypted: 'v1:x:y:z',
  licenceNumberLast4: '1234',
  licenceExpiry: inYears(3),
  licenceDocumentUrl: 'https://example.test/licence.png',
  transmissions: ['MANUAL', 'AUTOMATIC'],
  serviceTypes: ['NOW', 'SCHEDULED', 'HOURLY', 'OUTSTATION', 'EVENT'],
  experienceYears: 6,
  isOnline: true,
  agreementVersion: DRIVER_HIRE_AGREEMENT_VERSION,
  agreementAcceptedAt: new Date(),
  ...overrides,
});
await DriverHireProfile.insertMany([
  profile(drivers.anil),
  profile(drivers.bina),
  profile(drivers.chet),
  profile(drivers.manualOnly, { transmissions: ['MANUAL'] }),
  profile(drivers.expired, { licenceExpiry: new Date(Date.now() - 86400000) }),
  profile(drivers.offline, { isOnline: false }),
]);

for (const serviceType of ['NOW', 'SCHEDULED', 'HOURLY']) {
  await pricingService.publishPricing({
    adminId: admin,
    payload: {
      serviceType, baseFare: 300, includedMinutes: 60, minimumMinutes: 120, extraBlockMinutes: 60, extraBlockFare: 100,
      freeWaitingMinutes: 15, waitingPerMinute: 2, nightCharge: 0, bookingFee: 20, taxPercent: 5, platformCommissionPercent: 20,
      freeCancelMinutes: 5, freeCancelBeforePickupMinutes: 60, cancellationFee: 50, lateCancellationFee: 100,
      noShowWaitMinutes: 30, noShowFee: 150,
    },
  });
}
await pricingService.publishPricing({
  adminId: admin,
  payload: { serviceType: 'EVENT', bookingFee: 0, extraBlockMinutes: 60, extraBlockFare: 300, eventPackages: [{ code: 'wed6', name: 'Wedding 6h', minutes: 360, price: 2500 }] },
});

const car = await vehicleService.createVehicle({ customerId: customer, payload: { make: 'Maruti', model: 'Swift', transmission: 'automatic' } });

const PICKUP = { address: 'MG Road, Indore', latitude: 22.7196, longitude: 75.8577 };
const inHours = (hours) => new Date(Date.now() + hours * 3600000).toISOString();

const book = async ({ hours = 3, durationMinutes = 180, serviceType = 'SCHEDULED', extra = {} } = {}) => {
  const quote = await bookingService.createQuote({
    customerId: customer,
    payload: { serviceType, pickup: PICKUP, scheduledAt: serviceType === 'NOW' ? undefined : inHours(hours), durationMinutes, vehicleId: car.id, ...extra },
  });
  return bookingService.createBooking({ customerId: customer, payload: { quoteId: quote.quoteId, vehicleId: car.id, acceptTerms: true, paymentMethod: 'CASH' } });
};

// ── Quotes and booking creation ─────────────────────────────────────────────

console.log('Search a Driver — quotes and booking');

let quote;
await check('quote prices on the server with itemised lines and terms', async () => {
  quote = await bookingService.createQuote({
    customerId: customer,
    payload: { serviceType: 'SCHEDULED', pickup: PICKUP, scheduledAt: inHours(3), durationMinutes: 180, vehicleId: car.id, fare: { total: 1 } },
  });
  assert(quote.fare.total === 546, `total ${quote.fare.total}`);
  assert(quote.fare.lines.length === 3, 'three lines');
  assert(quote.terms.lateCancellationFee === 100, 'terms carried');
  assert(quote.terms.finalFareNote, 'explains what can change');
});

await expectReject('scheduled pickup too soon is refused', 'INVALID_SCHEDULE', () => bookingService.createQuote({
  customerId: customer, payload: { serviceType: 'SCHEDULED', pickup: PICKUP, scheduledAt: inHours(0.25), durationMinutes: 120 },
}));
await expectReject('outstation needs a destination', 'INVALID_LOCATION', () => bookingService.createQuote({
  customerId: customer, payload: { serviceType: 'OUTSTATION', pickup: PICKUP, scheduledAt: inHours(5), durationDays: 2 },
}));
await expectReject('unpriced service type is refused', 'PRICING_NOT_CONFIGURED', () => bookingService.createQuote({
  customerId: customer, payload: { serviceType: 'OUTSTATION', pickup: PICKUP, destination: PICKUP, scheduledAt: inHours(5), durationDays: 2 },
}));
await expectReject('unknown event package is refused', 'INVALID_PACKAGE', () => bookingService.createQuote({
  customerId: customer, payload: { serviceType: 'EVENT', pickup: PICKUP, scheduledAt: inHours(5), eventPackageCode: 'NOPE' },
}));
await check('event package sets the duration and price', async () => {
  const eventQuote = await bookingService.createQuote({
    customerId: customer, payload: { serviceType: 'EVENT', pickup: PICKUP, scheduledAt: inHours(5), eventPackageCode: 'WED6' },
  });
  assert(eventQuote.durationMinutes === 360 && eventQuote.fare.subtotal === 2500, JSON.stringify(eventQuote.fare));
});
await expectReject('booking requires accepting the terms', 'TERMS_NOT_ACCEPTED', () => bookingService.createBooking({
  customerId: customer, payload: { quoteId: quote.quoteId, vehicleId: car.id },
}));
await expectReject("another customer cannot use someone's quote", 'QUOTE_NOT_FOUND', () => bookingService.createBooking({
  customerId: otherCustomer, payload: { quoteId: quote.quoteId, vehicleId: car.id, acceptTerms: true },
}));

let first;
await check('double-tap confirm creates exactly one booking', async () => {
  const payload = { quoteId: quote.quoteId, vehicleId: car.id, acceptTerms: true, paymentMethod: 'CASH' };
  const results = await Promise.all([1, 2, 3].map(() => bookingService.createBooking({ customerId: customer, payload })));
  const ids = new Set(results.map((result) => result.id));
  assert(ids.size === 1, `got ${ids.size} distinct bookings`);
  assert(await DriverHireBooking.countDocuments({ quoteId: quote.quoteId }) === 1, 'one document');
  [first] = results;
  assert(first.status === 'REQUESTED' && first.fare.total === 546, 'requested with the quoted fare');
});

// ── Eligibility and assignment races ────────────────────────────────────────

console.log('Search a Driver — eligibility and assignment');

await expectReject('manual-only driver cannot take an automatic car', 'DRIVER_NOT_ELIGIBLE', () => lifecycle.acceptBooking({ driverId: drivers.manualOnly, bookingId: first.id }));
await expectReject('expired licence cannot take a booking', 'DRIVER_NOT_ELIGIBLE', () => lifecycle.acceptBooking({ driverId: drivers.expired, bookingId: first.id }));

await check('request card hides the address and customer', async () => {
  const requests = await lifecycle.listRequests({ driverId: drivers.anil });
  const card = requests.find((entry) => entry.id === first.id);
  assert(card, 'booking listed for an eligible driver');
  assert(!card.pickup && !card.customer && card.pickupArea, 'masked');
  assert(card.fare.estimatedEarnings === 400, `earnings ${card.fare.estimatedEarnings}`);
  assert(!JSON.stringify(card).includes('MG Road'), 'no address');
  const manual = await lifecycle.listRequests({ driverId: drivers.manualOnly });
  assert(!manual.some((entry) => entry.id === first.id), 'not shown to an ineligible driver');
});

await check('three drivers accept at once: exactly one wins', async () => {
  const results = await Promise.allSettled([drivers.anil, drivers.bina, drivers.chet].map((driverId) => lifecycle.acceptBooking({ driverId, bookingId: first.id })));
  const won = results.filter((result) => result.status === 'fulfilled');
  const lost = results.filter((result) => result.status === 'rejected');
  assert(won.length === 1, `${won.length} winners`);
  assert(lost.every((result) => ['BOOKING_TAKEN', 'INVALID_TRANSITION'].includes(result.reason.code)), lost.map((r) => r.reason.code).join(','));
});

const assigned = await DriverHireBooking.findById(first.id);
const winner = assigned.driverId;

await check('customer sees driver card and start code, not phone', async () => {
  const view = await bookingService.getBooking({ customerId: customer, bookingId: first.id });
  assert(view.status === 'DRIVER_ASSIGNED', view.status);
  assert(view.driver && /^[a-z]+ D\.$/.test(view.driver.name), `name ${view.driver?.name}`);
  assert(/^\d{4}$/.test(view.startCode || ''), 'start code shown');
  assert(!JSON.stringify(view).includes('98000000'), 'no driver phone');
});

await check('driver gets the address but not the customer phone or code', async () => {
  const view = await lifecycle.getDriverBooking({ driverId: winner, bookingId: first.id });
  assert(view.pickup.address === PICKUP.address && view.customer.firstName === 'Riya', 'details');
  assert(!JSON.stringify(view).includes('9000000001') && view.startCode === undefined, 'no phone, no code');
});

await expectReject('another customer cannot read the booking', 'BOOKING_NOT_FOUND', () => bookingService.getBooking({ customerId: otherCustomer, bookingId: first.id }));

await check('the same driver cannot be double-booked in parallel', async () => {
  const [a, b] = await Promise.all([book({ hours: 30 }), book({ hours: 30.5 })]);
  const results = await Promise.allSettled([a, b].map((entry) => lifecycle.acceptBooking({ driverId: drivers.chet, bookingId: entry.id })));
  const won = results.filter((result) => result.status === 'fulfilled').length;
  const busy = results.filter((result) => result.status === 'rejected' && result.reason.code === 'DRIVER_BUSY').length;
  assert(won === 1 && busy === 1, `won ${won}, busy ${busy}: ${results.map((r) => r.reason?.code).join(',')}`);
});

// ── Trip lifecycle ──────────────────────────────────────────────────────────

console.log('Search a Driver — trip');

await expectReject('cannot start before arriving', 'INVALID_TRANSITION', () => lifecycle.startTrip({ driverId: winner, bookingId: first.id, payload: { otp: '0000' } }));
await expectReject('cannot arrive before going en route', 'INVALID_TRANSITION', () => lifecycle.markArrived({ driverId: winner, bookingId: first.id, payload: PICKUP }));
const bystander = [drivers.anil, drivers.bina, drivers.chet].find((id) => String(id) !== String(winner));
await expectReject('a different driver cannot move it', 'BOOKING_NOT_FOUND', () => lifecycle.markEnRoute({ driverId: bystander, bookingId: first.id }));

await check('en route', async () => {
  const view = await lifecycle.markEnRoute({ driverId: winner, bookingId: first.id });
  assert(view.status === 'DRIVER_EN_ROUTE', view.status);
});
await expectReject('arrived only near the pickup', 'INVALID_LOCATION', () => lifecycle.markArrived({
  driverId: winner, bookingId: first.id, payload: { latitude: 22.75, longitude: 75.9 },
}));
await check('arrived at the pickup', async () => {
  const view = await lifecycle.markArrived({ driverId: winner, bookingId: first.id, payload: { latitude: 22.7197, longitude: 75.8578 } });
  assert(view.status === 'DRIVER_ARRIVED', view.status);
});
await expectReject('start needs the code or the customer confirming', 'START_NOT_CONFIRMED', () => lifecycle.startTrip({ driverId: winner, bookingId: first.id, payload: {} }));
await expectReject('wrong start code is refused', 'INVALID_OTP', () => lifecycle.startTrip({ driverId: winner, bookingId: first.id, payload: { otp: '99999' } }));
await expectReject('no-show cannot be reported before the wait time', 'INVALID_TRANSITION', () => lifecycle.reportNoShow({ driverId: winner, bookingId: first.id }));

// The driver waited 25 minutes before the customer came down.
await DriverHireBooking.updateOne({ _id: first.id }, { $set: { arrivedAt: new Date(Date.now() - 25 * 60000) } });

await check('correct start code starts the trip', async () => {
  const { startCode } = await bookingService.getBooking({ customerId: customer, bookingId: first.id });
  const view = await lifecycle.startTrip({ driverId: winner, bookingId: first.id, payload: { otp: startCode } });
  assert(view.status === 'TRIP_STARTED', view.status);
  const after = await bookingService.getBooking({ customerId: customer, bookingId: first.id });
  assert(after.startCode === null, 'code hidden once started');
});

await check('location only during the trip', async () => {
  await lifecycle.updateLocation({ driverId: winner, bookingId: first.id, payload: { latitude: 22.73, longitude: 75.86 } });
  const view = await bookingService.getBooking({ customerId: customer, bookingId: first.id });
  assert(view.driverLocation?.latitude === 22.73, 'tracked');
});

await expectReject('expenses must be valid', 'INVALID_EXPENSE', () => lifecycle.completeTrip({
  driverId: winner, bookingId: first.id, payload: { expenses: [{ kind: 'FUEL', amount: 100 }] },
}));

// Make the trip run 4h10m against 3h booked.
await DriverHireBooking.updateOne({ _id: first.id }, { $set: { startedAt: new Date(Date.now() - 250 * 60000), arrivedAt: new Date(Date.now() - 275 * 60000) } });

await check('complete: overtime, waiting and a toll on the receipt; payment recorded', async () => {
  await lifecycle.completeTrip({
    driverId: winner, bookingId: first.id, payload: { expenses: [{ kind: 'TOLL', amount: 60, note: 'Bypass' }], cashCollected: true },
  });
  const view = await bookingService.getBooking({ customerId: customer, bookingId: first.id });
  const codes = view.final.lines.map((line) => line.code);
  assert(view.status === 'TRIP_COMPLETED', view.status);
  assert(codes.includes('OVERTIME') && codes.includes('WAITING') && codes.includes('EXPENSE_TOLL'), codes.join(','));
  // base 300 + 4 blocks 400 + waiting 10 min × 2 = 720; +20 fee = 740; tax 5% = 37; +60 toll = 837.
  assert(view.final.total === 837, `total ${view.final.total}`);
  assert(view.driverLocation === null, 'location cleared');
  const payment = await DriverHirePayment.findOne({ bookingId: first.id, kind: 'TRIP' }).lean();
  assert(payment && payment.paymentStatus === 'PAID' && payment.amount === 837, JSON.stringify(payment));
  assert(payment.driverAmount === 636, `driver ${payment.driverAmount}`);
});

await expectReject('a completed trip cannot be cancelled', 'INVALID_TRANSITION', () => bookingService.cancelByCustomer({ customerId: customer, bookingId: first.id, reason: 'late' }));

await check('customer rates once; the driver average updates', async () => {
  await feedback.createReview({ role: 'user', actorId: customer, bookingId: first.id, payload: { rating: 4, comment: 'Smooth' } });
  const updated = await DriverHireProfile.findOne({ driverId: winner }).lean();
  assert(updated.ratingCount === 1 && updated.ratingAverage === 4, JSON.stringify({ c: updated.ratingCount, a: updated.ratingAverage }));
});
await expectReject('second rating is refused', 'DUPLICATE_RATING', () => feedback.createReview({ role: 'user', actorId: customer, bookingId: first.id, payload: { rating: 5 } }));

await check('dispute and partial refund', async () => {
  await adminService.openDispute({ adminId: admin, bookingId: first.id, note: 'Customer disputes waiting charge' });
  await adminService.resolveDispute({ adminId: admin, bookingId: first.id, payload: { outcome: 'Waiting waived', refundAmount: 20 } });
  const payment = await DriverHirePayment.findOne({ bookingId: first.id, kind: 'TRIP' }).lean();
  const booking = await DriverHireBooking.findById(first.id).lean();
  assert(booking.status === 'TRIP_COMPLETED' && payment.refundAmount === 20 && payment.refundStatus === 'PENDING', 'refund recorded');
});

// ── Cancellations and releases ──────────────────────────────────────────────

console.log('Search a Driver — cancellations');

await expectReject('cancelling needs a reason', 'REASON_REQUIRED', async () => {
  const booking = await book({ hours: 50 });
  return bookingService.cancelByCustomer({ customerId: customer, bookingId: booking.id, reason: ' ' });
});

await check('cancel before assignment is free', async () => {
  const booking = await book({ hours: 52 });
  const view = await bookingService.cancelByCustomer({ customerId: customer, bookingId: booking.id, reason: 'Plans changed' });
  assert(view.status === 'CANCELLED_BY_CUSTOMER' && view.cancellation.fee === 0, JSON.stringify(view.cancellation));
  assert(!(await DriverHirePayment.exists({ bookingId: booking.id })), 'no fee row');
});

await check('cancel after the driver set off costs the late fee', async () => {
  const booking = await book({ hours: 54 });
  await lifecycle.acceptBooking({ driverId: drivers.bina, bookingId: booking.id });
  await lifecycle.markEnRoute({ driverId: drivers.bina, bookingId: booking.id });
  const view = await bookingService.cancelByCustomer({ customerId: customer, bookingId: booking.id, reason: 'Found another way' });
  assert(view.cancellation.fee === 100, `fee ${view.cancellation.fee}`);
  const payment = await DriverHirePayment.findOne({ bookingId: booking.id }).lean();
  assert(payment.kind === 'CANCELLATION_FEE' && payment.driverAmount === 80, JSON.stringify(payment));
});

await check('driver cancelling re-opens the booking for someone else', async () => {
  const booking = await book({ hours: 60 });
  await lifecycle.acceptBooking({ driverId: drivers.bina, bookingId: booking.id });
  const result = await lifecycle.cancelByDriver({ driverId: drivers.bina, bookingId: booking.id, reason: 'Unwell' });
  assert(result.status === 'REQUESTED', result.status);
  const reloaded = await DriverHireBooking.findById(booking.id).lean();
  assert(!reloaded.driverId && reloaded.declinedDriverIds.some((id) => String(id) === String(drivers.bina)), 'released');
  try {
    await lifecycle.acceptBooking({ driverId: drivers.bina, bookingId: booking.id });
    throw new Error('re-accepted');
  } catch (error) {
    assert(error.code === 'DRIVER_NOT_ELIGIBLE', error.code);
  }
  await lifecycle.acceptBooking({ driverId: drivers.anil, bookingId: booking.id });
});

await check('NOW booking needs an online driver; scheduled can go to an offline one', async () => {
  const now = await book({ serviceType: 'NOW', durationMinutes: 120 });
  try {
    await lifecycle.acceptBooking({ driverId: drivers.offline, bookingId: now.id });
    throw new Error('offline accepted NOW');
  } catch (error) {
    assert(error.code === 'DRIVER_NOT_ELIGIBLE', error.code);
  }
  const later = await book({ hours: 80 });
  await lifecycle.acceptBooking({ driverId: drivers.offline, bookingId: later.id });
});

// ── Admin assignment, offers and sweep ──────────────────────────────────────

console.log('Search a Driver — admin and sweep');

await check('admin offer reserves the booking for that driver', async () => {
  const booking = await book({ hours: 90 });
  await adminService.assignBooking({ adminId: admin, bookingId: booking.id, payload: { driverId: String(drivers.bina) } });
  try {
    await lifecycle.acceptBooking({ driverId: drivers.anil, bookingId: booking.id });
    throw new Error('someone else took an offered booking');
  } catch (error) {
    assert(error.code === 'BOOKING_TAKEN', error.code);
  }
  await lifecycle.acceptBooking({ driverId: drivers.bina, bookingId: booking.id });
});

await check('an unanswered offer times out and the driver counts as declined', async () => {
  const booking = await book({ hours: 100 });
  await adminService.assignBooking({ adminId: admin, bookingId: booking.id, payload: { driverId: String(drivers.chet) } });
  await DriverHireBooking.updateOne({ _id: booking.id }, { $set: { 'offer.expiresAt': new Date(Date.now() - 1000) } });
  const result = await sweep.runDriverHireSweep();
  assert(result.offersTimedOut >= 1, JSON.stringify(result));
  const reloaded = await DriverHireBooking.findById(booking.id).lean();
  assert(!reloaded.offer.driverId && reloaded.declinedDriverIds.some((id) => String(id) === String(drivers.chet)), 'cleared');
});

await check('an unassigned booking past its pickup expires without a charge', async () => {
  const booking = await book({ hours: 110 });
  await DriverHireBooking.updateOne({ _id: booking.id }, { $set: { scheduledAt: new Date(Date.now() - 2 * 3600000) } });
  await sweep.runDriverHireSweep();
  const reloaded = await DriverHireBooking.findById(booking.id).lean();
  assert(reloaded.status === 'EXPIRED', reloaded.status);
  assert(!(await DriverHirePayment.exists({ bookingId: booking.id })), 'no charge');
});

await check('admin direct assignment and reassignment', async () => {
  const booking = await book({ hours: 120 });
  await adminService.assignBooking({ adminId: admin, bookingId: booking.id, payload: { driverId: String(drivers.anil), direct: true } });
  let reloaded = await DriverHireBooking.findById(booking.id).lean();
  assert(reloaded.status === 'DRIVER_ASSIGNED', reloaded.status);
  await adminService.reassignBooking({ adminId: admin, bookingId: booking.id, reason: 'Driver called in sick' });
  reloaded = await DriverHireBooking.findById(booking.id).lean();
  assert(reloaded.status === 'REQUESTED' && !reloaded.driverId, 'back in queue');
});

await check('admin view never carries the start code', async () => {
  const detail = await adminService.getBookingDetail({ bookingId: first.id });
  assert(!JSON.stringify(detail).includes('startOtp'), 'no otp');
  assert(detail.audit.length >= 5, `audit ${detail.audit.length}`);
});

await check('pricing changes are versioned; old bookings keep their terms', async () => {
  const published = await pricingService.publishPricing({ adminId: admin, payload: { serviceType: 'SCHEDULED', baseFare: 999 } });
  assert(published.version === 2 && published.extraBlockFare === 100, 'new version keeps unchanged fields');
  const current = await pricingService.listPricing();
  assert(current.filter((rule) => rule.serviceType === 'SCHEDULED').length === 1, 'one current');
  const old = await DriverHireBooking.findById(first.id).lean();
  assert(old.fare.pricingVersion === 1 && old.fare.terms.baseFare === 300, 'old booking unchanged');
  assert(await DriverHireAuditLog.exists({ action: 'PRICING_PUBLISHED' }), 'audited');
});

await check('profile review: approve needs a valid licence; suspend takes the driver offline', async () => {
  const p = await DriverHireProfile.findOne({ driverId: drivers.anil });
  await profileService.adminReviewProfile({ adminId: admin, profileId: p._id, action: 'suspend', reason: 'Complaint under review' });
  const after = await DriverHireProfile.findById(p._id).lean();
  assert(after.verificationStatus === 'SUSPENDED' && after.isOnline === false, 'suspended');
  const expired = await DriverHireProfile.findOne({ driverId: drivers.expired });
  expired.verificationStatus = 'PENDING';
  await expired.save();
  try {
    await profileService.adminReviewProfile({ adminId: admin, profileId: expired._id, action: 'approve' });
    throw new Error('approved an expired licence');
  } catch (error) {
    assert(error.code === 'DRIVER_NOT_ELIGIBLE', error.code);
  }
});

await check('report counts', async () => {
  const report = await adminService.getReport({ query: { from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 30 * 86400000).toISOString() } });
  assert(report.totalBookings > 5 && report.byStatus.TRIP_COMPLETED === 1 && report.cancellations.noDriverFound >= 1, JSON.stringify(report.byStatus));
});

await check('safety reports open as urgent', async () => {
  const entry = await feedback.createSupportCase({ role: 'driver', actorId: winner, payload: { bookingId: first.id, category: 'safety', description: 'Customer asked me to speed' } });
  assert(entry.priority === 'URGENT', entry.priority);
});

console.log(`\n${pass} passed, ${fail} failed`);
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
