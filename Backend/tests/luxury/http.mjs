/**
 * Luxury Car module — seed script, vehicle catalog and ride trip details.
 *
 *   LUXURY_TEST_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0 node tests/luxury/http.mjs
 *
 * Runs scripts/seedLuxuryCars.js against a throwaway database, then checks the
 * public vehicle catalog carries tier and amenities, and that the admin API
 * saves them.
 */
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_NAME = `luxury_api_${Date.now()}`;
process.env.MONGODB_URI = process.env.LUXURY_TEST_URI
  ? process.env.LUXURY_TEST_URI.replace(/\/(\?|$)/, `/${DB_NAME}$1`)
  : `mongodb://127.0.0.1:27017/${DB_NAME}?replicaSet=rs0&directConnection=true`;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'api-test-secret';
process.env.NODE_ENV = 'test';
process.env.DRIVER_HIRE_SWEEP_ENABLED = 'false';

const { createApp } = await import('../../src/app.js');
const { updateVehicleType, getVehicleTypeById } = await import('../../src/modules/taxi/admin/services/adminService.js');

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
const vehicles = mongoose.connection.collection('taxivehicles');

// An existing luxury car from before tiers existed, plus one already tiered.
await vehicles.insertMany([
  { name: 'BMW 5 Series', category: 'luxury', is_luxury: true, transport_type: 'taxi', capacity: 4, luggage_capacity: 3, status: 1, active: true },
  { name: 'Mercedes-Benz E-Class', category: 'luxury', is_luxury: true, transport_type: 'taxi', capacity: 4, luggage_capacity: 3, status: 1, active: true, luxury_tier: 'luxury_sedan', amenities: ['Custom amenity'] },
]);

const runSeed = (...args) =>
  execFileSync(process.execPath, ['scripts/seedLuxuryCars.js', ...args], { cwd: rootDir, env: process.env, encoding: 'utf8' });

console.log('seed');
const dry = runSeed();
check('dry run writes nothing', (await vehicles.countDocuments()) === 2, dry);
runSeed('--apply');
const again = runSeed('--apply');
check('re-run changes nothing', !/create |fill /.test(again), again);
check('one car per tier', (await vehicles.distinct('luxury_tier', { category: 'luxury' })).sort().join() === 'luxury_sedan,luxury_suv,premium_mpv,premium_sedan,premium_suv');
const bmw = await vehicles.findOne({ name: 'BMW 5 Series' });
check('existing car gets tier and amenities', bmw.luxury_tier === 'luxury_sedan' && bmw.amenities.length > 0);
const eClass = await vehicles.find({ name: 'Mercedes-Benz E-Class' }).toArray();
check('existing car keeps its own amenities and is not duplicated', eClass.length === 1 && eClass[0].amenities.join() === 'Custom amenity');
check('global prices for the 4 new cars (no zones)', (await mongoose.connection.collection('taxisetprices').countDocuments({ zone_id: null })) === 4);
const gle = await vehicles.findOne({ name: 'Mercedes-Benz GLE' });
const glePrice = await mongoose.connection.collection('taxisetprices').findOne({ vehicle_type: gle._id });
check('price has outstation rate', glePrice.outstation_price_per_distance === 50 && glePrice.base_price === 1499);

console.log('catalog');
const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const catalog = await (await fetch(`${base}/users/vehicle-types`)).json();
const list = catalog.data?.results || catalog.data || [];
const gleItem = (Array.isArray(list) ? list : []).find((item) => item.name === 'Mercedes-Benz GLE');
check('public catalog returns tier and amenities', gleItem?.luxury_tier === 'luxury_suv' && gleItem?.amenities?.includes('Panoramic sunroof'), JSON.stringify(catalog).slice(0, 300));

console.log('admin update');
await updateVehicleType(String(gle._id), { luxury_tier: 'Premium_SUV', amenities: 'Wi-Fi, Newspaper , ' });
const updated = await getVehicleTypeById(String(gle._id));
check('admin saves tier (normalised) and comma-separated amenities', updated.luxury_tier === 'premium_suv' && updated.amenities.join('|') === 'Wi-Fi|Newspaper', JSON.stringify(updated.amenities));
await updateVehicleType(String(gle._id), { luxury_tier: 'spaceship' });
check('unknown tier is cleared', (await getVehicleTypeById(String(gle._id))).luxury_tier === '');

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(failures === 0 ? '\nall luxury checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
