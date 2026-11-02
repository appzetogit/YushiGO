/**
 * Give ride prices to active vehicles that have none, so the app can quote and
 * book them. Each copies the current price of a similar vehicle (same seats and
 * use), or gets its own rate where nothing similar exists.
 *
 * Goes through the admin createSetPrice. A vehicle that already has a ride price
 * in that zone is left alone; edit prices in Admin > Set Prices.
 *
 *   node scripts/seedMissingRidePrices.js           # dry run, prints the plan
 *   node scripts/seedMissingRidePrices.js --apply   # writes
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const apply = process.argv.includes('--apply');

const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { SetPrice } = await import('../src/modules/taxi/admin/models/SetPrice.js');
const { createSetPrice } = await import('../src/modules/taxi/admin/services/adminService.js');

const PLAN = [
  { name: 'Safety Comfort Cab', copyFrom: 'YushiGo Fast' },
  { name: 'School Auto', copyFrom: 'Texi Go' },
  { name: 'Verified School Van', copyFrom: 'Tempo Traveller' },
  {
    name: 'Luxury Volvo Bus',
    price: {
      base_price: 6000,
      base_distance: 10,
      price_per_distance: 60,
      waiting_charge: 8,
      free_waiting_before: 20,
      user_cancellation_fee: 1200,
      user_cancellation_fee_type: 'fixed',
      support_outstation: 1,
      outstation_base_price: 6000,
      outstation_base_distance: 10,
      outstation_price_per_distance: 60,
    },
  },
];

// Fields copied from the reference price; ids, vehicle and timestamps are not.
const COPY_FIELDS = [
  'zone_id', 'service_location_id', 'transport_type', 'payment_type', 'service_tax',
  'base_price', 'base_distance', 'price_per_distance', 'time_price', 'waiting_charge',
  'free_waiting_before', 'free_waiting_after',
  'support_outstation', 'outstation_base_price', 'outstation_base_distance',
  'outstation_price_per_distance', 'outstation_time_price',
  'user_cancellation_fee', 'user_cancellation_fee_type', 'driver_cancellation_fee', 'driver_cancellation_fee_type',
  'cancellation_fee_goes_to', 'admin_commision_type', 'admin_commision',
];

const log = (...args) => console.log(apply ? '[apply]' : '[dry-run]', ...args);

const findVehicle = (name) => Vehicle.findOne({ name: new RegExp(`^${name}$`, 'i'), status: 1 }).lean();

try {
  await mongoose.connect(process.env.MONGODB_URI);
  for (const item of PLAN) {
    const vehicle = await findVehicle(item.name);
    if (!vehicle) {
      log(`"${item.name}" not found or inactive, skipped`);
      continue;
    }

    let payloads;
    if (item.copyFrom) {
      const reference = await findVehicle(item.copyFrom);
      const referencePrices = reference
        ? await SetPrice.find({ vehicle_type: reference._id, pricing_scope: 'ride', status: 'active' }).lean()
        : [];
      if (referencePrices.length === 0) {
        log(`"${item.name}": "${item.copyFrom}" has no ride price to copy, skipped`);
        continue;
      }
      payloads = referencePrices.map((price) => Object.fromEntries(COPY_FIELDS.filter((key) => price[key] !== undefined).map((key) => [key, price[key]])));
    } else {
      payloads = [{ zone_id: null, transport_type: 'taxi', payment_type: ['cash', 'online'], ...item.price }];
    }

    for (const payload of payloads) {
      const exists = await SetPrice.exists({ vehicle_type: vehicle._id, zone_id: payload.zone_id ?? null, pricing_scope: 'ride' });
      if (exists) {
        log(`"${item.name}" already has a ride price${payload.zone_id ? ' in that zone' : ''}, kept as is`);
        continue;
      }
      const source = item.copyFrom ? `copied from "${item.copyFrom}"` : 'own rate';
      log(`create price for "${item.name}" (${source}): base ${payload.base_price} for ${payload.base_distance} km, ${payload.price_per_distance}/km`);
      if (apply) {
        await createSetPrice({ ...payload, vehicle_type: vehicle._id, pricing_scope: 'ride', status: 'active' });
      }
    }
  }
  log(apply ? 'done' : 'nothing written; re-run with --apply to write');
} catch (error) {
  console.error('Failed:', error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
