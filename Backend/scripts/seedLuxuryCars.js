/**
 * Seed the Luxury Car module (chauffeur-driven):
 *   1. one luxury vehicle type per tier (Premium Sedan, Luxury Sedan,
 *      Premium SUV, Luxury SUV, Premium MPV), with amenities,
 *   2. a ride SetPrice for each new one in every usable zone (global when
 *      there are no zones), including outstation rates,
 *   3. tier and amenities on existing luxury vehicles that have none yet.
 *
 * New records go through the same admin service functions the admin panel
 * uses. Existing vehicles keep everything they already have: only an empty
 * tier or empty amenities list is filled in. Safe to re-run.
 *
 *   node scripts/seedLuxuryCars.js           # dry run, prints the plan
 *   node scripts/seedLuxuryCars.js --apply   # writes
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const apply = process.argv.includes('--apply');

const { Vehicle } = await import('../src/modules/taxi/admin/models/Vehicle.js');
const { SetPrice } = await import('../src/modules/taxi/admin/models/SetPrice.js');
const { Zone } = await import('../src/modules/taxi/driver/models/Zone.js');
const { createVehicleType, createSetPrice } = await import('../src/modules/taxi/admin/services/adminService.js');

const SEDAN_AMENITIES = ['Leather seats', 'Bottled water', 'Phone charger', 'Uniformed chauffeur'];
const SUV_AMENITIES = ['Leather seats', 'Bottled water', 'Phone charger', 'Large boot', 'Uniformed chauffeur'];

// Existing luxury cars with no tier get one by name; anything else defaults to luxury_sedan.
const TIER_BY_NAME = [
  [/e-class|5 series|a6|s-class|7 series|a8|xf/i, 'luxury_sedan'],
  [/gle|x5|q7|range rover|xc90|gls/i, 'luxury_suv'],
  [/camry|superb|accord|octavia/i, 'premium_sedan'],
  [/fortuner|gloster|kodiaq|tucson|meridian/i, 'premium_suv'],
  [/innova|carnival|hycross|kia carens/i, 'premium_mpv'],
];

const LUXURY_CARS = [
  {
    name: 'Toyota Camry Hybrid',
    luxury_tier: 'premium_sedan',
    short_description: 'Premium Sedan | 4 seats | 2 bags',
    description: 'Quiet hybrid sedan for airport runs and city meetings.',
    capacity: 4,
    luggage_capacity: 2,
    amenities: SEDAN_AMENITIES,
    price: { base_price: 499, base_distance: 5, price_per_distance: 28, waiting_charge: 4, free_waiting_before: 15, user_cancellation_fee: 300, outstation_price_per_distance: 22 },
  },
  {
    name: 'Mercedes-Benz E-Class',
    luxury_tier: 'luxury_sedan',
    short_description: 'Luxury Sedan | 4 seats | 3 bags',
    description: 'Executive sedan for business travel and weddings.',
    capacity: 4,
    luggage_capacity: 3,
    amenities: [...SEDAN_AMENITIES, 'Rear climate control'],
    price: { base_price: 999, base_distance: 5, price_per_distance: 45, waiting_charge: 6, free_waiting_before: 15, user_cancellation_fee: 500, outstation_price_per_distance: 38 },
  },
  {
    name: 'Toyota Fortuner',
    luxury_tier: 'premium_suv',
    short_description: 'Premium SUV | 6 seats | 4 bags',
    description: 'Spacious SUV for families and outstation trips.',
    capacity: 6,
    luggage_capacity: 4,
    amenities: SUV_AMENITIES,
    price: { base_price: 799, base_distance: 5, price_per_distance: 36, waiting_charge: 5, free_waiting_before: 15, user_cancellation_fee: 400, outstation_price_per_distance: 30 },
  },
  {
    name: 'Mercedes-Benz GLE',
    luxury_tier: 'luxury_suv',
    short_description: 'Luxury SUV | 5 seats | 4 bags',
    description: 'Flagship SUV for VIP guests, weddings and events.',
    capacity: 5,
    luggage_capacity: 4,
    amenities: [...SUV_AMENITIES, 'Panoramic sunroof'],
    price: { base_price: 1499, base_distance: 5, price_per_distance: 60, waiting_charge: 8, free_waiting_before: 15, user_cancellation_fee: 800, outstation_price_per_distance: 50 },
  },
  {
    name: 'Toyota Innova Hycross',
    luxury_tier: 'premium_mpv',
    short_description: 'Premium MPV | 6 seats | 4 bags',
    description: 'Captain-seat MPV for groups, families and airport transfers.',
    capacity: 6,
    luggage_capacity: 4,
    amenities: ['Captain seats', 'Bottled water', 'Phone charger', 'Uniformed chauffeur'],
    price: { base_price: 699, base_distance: 5, price_per_distance: 32, waiting_charge: 5, free_waiting_before: 15, user_cancellation_fee: 400, outstation_price_per_distance: 26 },
  },
];

const log = (...args) => console.log(apply ? '[apply]' : '[dry-run]', ...args);

const tierForName = (name) => TIER_BY_NAME.find(([pattern]) => pattern.test(name))?.[1] || 'luxury_sedan';

const fillExistingLuxuryCars = async () => {
  const existing = await Vehicle.find({ $or: [{ category: 'luxury' }, { is_luxury: true }] }).lean();
  for (const vehicle of existing) {
    const update = {};
    if (!vehicle.luxury_tier) update.luxury_tier = tierForName(vehicle.name);
    if (!Array.isArray(vehicle.amenities) || vehicle.amenities.length === 0) {
      update.amenities = update.luxury_tier?.includes('suv') || vehicle.luxury_tier?.includes('suv') ? SUV_AMENITIES : SEDAN_AMENITIES;
    }
    if (Object.keys(update).length === 0) {
      log(`luxury car "${vehicle.name}" already has tier "${vehicle.luxury_tier}" and amenities, kept as is`);
      continue;
    }
    log(`fill "${vehicle.name}": ${Object.keys(update).map((key) => `${key}=${JSON.stringify(update[key])}`).join(', ')}`);
    if (apply) await Vehicle.updateOne({ _id: vehicle._id }, { $set: update });
  }
};

const seedCars = async () => {
  const created = [];
  for (const spec of LUXURY_CARS) {
    const existing = await Vehicle.findOne({ name: new RegExp(`^${spec.name}$`, 'i') }).lean();
    if (existing) {
      log(`luxury car "${spec.name}" exists, kept as is`);
      continue;
    }
    log(`create luxury car "${spec.name}" (${spec.luxury_tier}, ${spec.capacity} seats, ${spec.luggage_capacity} bags)`);
    if (apply) {
      const vehicle = await createVehicleType({
        name: spec.name,
        short_description: spec.short_description,
        description: spec.description,
        transport_type: 'taxi',
        category: 'luxury',
        is_luxury: true,
        icon_types: spec.luxury_tier.includes('sedan') ? 'Luxary' : 'suv',
        luxury_tier: spec.luxury_tier,
        amenities: spec.amenities,
        capacity: spec.capacity,
        luggage_capacity: spec.luggage_capacity,
        status: 1,
      });
      created.push({ spec, vehicleId: vehicle._id });
    } else {
      created.push({ spec, vehicleId: null });
    }
  }
  return created;
};

const seedPrices = async (created) => {
  const activeZones = await Zone.find({ active: { $ne: false }, status: { $ne: 'inactive' } }).select('_id name').lean();
  // Without zones the ride prices are global (zone_id null), as the existing ones are.
  const zones = activeZones.length > 0 ? activeZones : [{ _id: null, name: 'all areas (no zones set up)' }];
  for (const { spec, vehicleId } of created) {
    for (const zone of zones) {
      if (vehicleId && (await SetPrice.exists({ zone_id: zone._id, vehicle_type: vehicleId, pricing_scope: 'ride' }))) {
        log(`price for "${spec.name}" in "${zone.name}" exists, kept as is`);
        continue;
      }
      log(`create price for "${spec.name}" in "${zone.name}": base ${spec.price.base_price}, ${spec.price.price_per_distance}/km`);
      if (apply) {
        const { outstation_price_per_distance: outstationPerKm, ...price } = spec.price;
        await createSetPrice({
          zone_id: zone._id,
          vehicle_type: vehicleId,
          transport_type: 'taxi',
          pricing_scope: 'ride',
          payment_type: ['cash', 'online'],
          user_cancellation_fee_type: 'fixed',
          support_outstation: 1,
          outstation_base_price: price.base_price,
          outstation_base_distance: price.base_distance,
          outstation_price_per_distance: outstationPerKm,
          ...price,
        });
      }
    }
  }
};

try {
  await mongoose.connect(process.env.MONGODB_URI);
  await fillExistingLuxuryCars();
  const created = await seedCars();
  await seedPrices(created);
  log(apply ? 'done' : 'nothing written; re-run with --apply to write');
} catch (error) {
  console.error('Failed:', error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
