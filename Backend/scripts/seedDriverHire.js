/**
 * Seed the Search a Driver module (a verified driver drives the customer's own car):
 *   1. default fare rules (all areas) for each service type: Now, Scheduled,
 *      Hourly, Outstation and Event (with event packages),
 *   2. the "Search a Driver" home-screen tile, if no module opens it yet.
 *
 * Rules are published through the same pricingService.publishPricing the admin
 * panel uses, so each gets version 1 and an audit entry. A service type that
 * already has current rules is left alone; edit those in Admin > Driver Hire >
 * Pricing. The amounts are illustrative launch rates for the admin to review,
 * not market rates.
 *
 *   node scripts/seedDriverHire.js           # dry run, prints the plan
 *   node scripts/seedDriverHire.js --apply   # writes
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const apply = process.argv.includes('--apply');

const { DriverHirePricing } = await import('../src/modules/taxi/driverHire/models/DriverHirePricing.js');
const { publishPricing } = await import('../src/modules/taxi/driverHire/services/pricingService.js');
const { TaxiAppModule } = await import('../src/modules/taxi/admin/models/TaxiAppModule.js');
const { createAppModule } = await import('../src/modules/taxi/admin/services/adminService.js');

const SHARED = {
  freeWaitingMinutes: 15,
  waitingPerMinute: 2,
  nightCharge: 150,
  nightStartHour: 22,
  nightEndHour: 6,
  bookingFee: 29,
  taxPercent: 5,
  platformCommissionPercent: 20,
  freeCancelMinutes: 5,
  freeCancelBeforePickupMinutes: 60,
  cancellationFee: 0,
  lateCancellationFee: 100,
  noShowWaitMinutes: 30,
  noShowFee: 150,
  allowDriverExpenses: true,
  notes: 'Illustrative launch rates from scripts/seedDriverHire.js; review before launch.',
};

const RULES = {
  NOW: { baseFare: 399, includedMinutes: 120, minimumMinutes: 120, extraBlockMinutes: 60, extraBlockFare: 129 },
  SCHEDULED: { baseFare: 379, includedMinutes: 120, minimumMinutes: 120, extraBlockMinutes: 60, extraBlockFare: 129 },
  HOURLY: { baseFare: 549, includedMinutes: 240, minimumMinutes: 240, extraBlockMinutes: 60, extraBlockFare: 119 },
  // Priced per 24-hour day: base covers day one, each further day is one block.
  OUTSTATION: {
    baseFare: 1199,
    includedMinutes: 1440,
    minimumMinutes: 1440,
    extraBlockMinutes: 1440,
    extraBlockFare: 1199,
    dailyAllowance: 300,
    overnightAllowance: 400,
    oneWayReturnFare: 500,
  },
  EVENT: {
    baseFare: 0,
    includedMinutes: 240,
    minimumMinutes: 240,
    extraBlockMinutes: 60,
    extraBlockFare: 149,
    eventPackages: [
      { code: 'HALF_DAY', name: 'Half day (4 hours)', minutes: 240, price: 899 },
      { code: 'FULL_DAY', name: 'Full day (8 hours)', minutes: 480, price: 1599 },
      { code: 'WEDDING', name: 'Wedding (12 hours)', minutes: 720, price: 2499 },
    ],
  },
};

const DRIVER_TILE_PATTERN = /(search|hire|book).{0,3}(a )?driver/i;

const log = (...args) => console.log(apply ? '[apply]' : '[dry-run]', ...args);

const seedPricing = async () => {
  for (const [serviceType, rules] of Object.entries(RULES)) {
    const current = await DriverHirePricing.findOne({ serviceLocationId: null, serviceType, current: true }).lean();
    if (current) {
      log(`${serviceType} rules exist (version ${current.version}), kept as is`);
      continue;
    }
    const packages = rules.eventPackages ? `, ${rules.eventPackages.length} event packages` : '';
    log(`publish ${serviceType} rules for all areas: base ${rules.baseFare} for ${rules.includedMinutes} min${packages}`);
    if (apply) {
      await publishPricing({ adminId: null, payload: { serviceType, serviceLocationId: null, ...SHARED, ...rules } });
    }
  }
};

const seedHomeTile = async () => {
  const modules = await TaxiAppModule.find().select('name').lean();
  const existing = modules.find((item) => DRIVER_TILE_PATTERN.test(String(item.name || '')));
  if (existing) {
    log(`home tile "${existing.name}" already opens Search a Driver, kept as is`);
    return;
  }
  log('create home tile "Search a Driver"');
  if (apply) {
    await createAppModule({
      name: 'Search a Driver',
      transport_type: 'taxi',
      service_type: 'normal',
      order_by: 10,
      short_description: 'Your car. Your journey. Our verified drivers.',
      description: 'Book a verified driver to drive your own car: now, scheduled, hourly, outstation or for an event.',
      active: 1,
    });
  }
};

try {
  await mongoose.connect(process.env.MONGODB_URI);
  await seedPricing();
  await seedHomeTile();
  log(apply ? 'done' : 'nothing written; re-run with --apply to write');
} catch (error) {
  console.error('Failed:', error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
