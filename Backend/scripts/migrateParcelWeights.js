/**
 * Convert parcel.weight from free text to a number of kilograms.
 *
 *   node scripts/migrateParcelWeights.js            # dry run, prints the plan
 *   node scripts/migrateParcelWeights.js --apply    # writes it
 *
 * Covers the dispatch rides and the Delivery documents. "5 kg" becomes 5, an
 * empty or unreadable value becomes null. Numbers are left alone, so a second
 * run changes nothing.
 */
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { parseWeightKg } from '../src/modules/taxi/user/services/parcelPolicy.js';

const COLLECTIONS = ['taxirides', 'deliveries'];

export const migrateParcelWeights = async ({ apply = false, log = console.log } = {}) => {
  const summary = {};

  for (const name of COLLECTIONS) {
    const collection = mongoose.connection.collection(name);
    const cursor = collection.find(
      { 'parcel.weight': { $type: 'string' } },
      { projection: { _id: 1, 'parcel.weight': 1 } },
    );

    const stats = { scanned: 0, toNumber: 0, toNull: 0 };

    for await (const doc of cursor) {
      stats.scanned += 1;
      const weight = parseWeightKg(doc.parcel?.weight);
      const next = weight !== null && weight > 0 ? weight : null;

      stats[next === null ? 'toNull' : 'toNumber'] += 1;

      if (next !== null) {
        log(`  ${name} ${doc._id}: "${doc.parcel.weight}" -> ${next}`);
      }

      if (apply) {
        await collection.updateOne({ _id: doc._id }, { $set: { 'parcel.weight': next } });
      }
    }

    summary[name] = stats;
  }

  return summary;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  dotenv.config();
  const apply = process.argv.includes('--apply');

  try {
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
    const summary = await migrateParcelWeights({ apply });
    console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'}`, JSON.stringify(summary));
    if (!apply) console.log('Re-run with --apply to write.');
  } finally {
    await mongoose.disconnect();
  }
}
