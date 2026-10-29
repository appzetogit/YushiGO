/**
 * Vehicle type categories — fill in the ones that are blank or still 'car'.
 *
 *   node scripts/migrateVehicleCategories.js            # dry run
 *   node scripts/migrateVehicleCategories.js --apply    # writes it
 *
 * 'car' becomes 'taxi'; a blank category is set from the icon type (bike, auto,
 * luxury for Luxary/premium, otherwise taxi). A category an admin already chose
 * is never changed. The API already reports the same values for blank records,
 * so this only makes the stored data match.
 */
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

const categoryFromIcon = (icon = '') => {
  const value = String(icon).trim().toLowerCase();
  if (value === 'bike') return 'bike';
  if (value === 'auto') return 'auto';
  if (['luxary', 'premium'].includes(value)) return 'luxury';
  return 'taxi';
};

export const migrateVehicleCategories = async ({ apply = false } = {}) => {
  const vehicles = mongoose.connection.collection('taxivehicles');
  const pending = await vehicles
    .find({ $or: [{ category: { $in: ['', 'car', null] } }, { category: { $exists: false } }] })
    .project({ name: 1, icon_types: 1, category: 1 })
    .toArray();

  const changes = pending.map((vehicle) => ({
    id: String(vehicle._id),
    name: vehicle.name,
    from: vehicle.category ?? '',
    to: vehicle.category === 'car' ? 'taxi' : categoryFromIcon(vehicle.icon_types),
  }));

  if (apply) {
    for (const change of changes) {
      await vehicles.updateOne(
        { _id: new mongoose.Types.ObjectId(change.id), category: change.from === '' ? { $in: ['', null] } : change.from },
        { $set: { category: change.to } },
      );
    }
  }

  return changes;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  dotenv.config();
  const apply = process.argv.includes('--apply');

  try {
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
    const changes = await migrateVehicleCategories({ apply });
    console.log(apply ? 'APPLIED' : 'DRY RUN');
    changes.forEach((change) => console.log(`  ${change.name}: "${change.from}" -> "${change.to}"`));
    if (!changes.length) console.log('  nothing to change');
    if (!apply) console.log('Re-run with --apply to write.');
  } finally {
    await mongoose.disconnect();
  }
}
