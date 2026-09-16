/**
 * Backfill Driver.completedRidesCount from existing completed rides.
 *
 *   node scripts/backfillDriverCompletedRides.js            # dry run, prints the plan
 *   node scripts/backfillDriverCompletedRides.js --apply    # writes it
 *
 * The counter is incremented as rides complete, but drivers who completed rides
 * before it existed start at zero. This sets each driver's counter to the true
 * total, so it is idempotent: running it twice produces the same result.
 *
 * Run it once, promptly after deploying the counter. A ride that completes
 * between the aggregation and the write for its driver would be counted twice;
 * re-running afterwards corrects that.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const apply = process.argv.includes('--apply');

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

  const rides = mongoose.connection.collection('taxirides');
  const drivers = mongoose.connection.collection('taxidrivers');

  const totals = await rides.aggregate([
    { $match: { status: 'completed', driverId: { $ne: null } } },
    { $group: { _id: '$driverId', total: { $sum: 1 } } },
  ]).toArray();

  const byDriver = new Map(totals.map((row) => [String(row._id), row.total]));
  const allDrivers = await drivers.find({}, { projection: { _id: 1, name: 1, completedRidesCount: 1 } }).toArray();

  let changed = 0;

  for (const driver of allDrivers) {
    const expected = byDriver.get(String(driver._id)) || 0;
    const current = Number(driver.completedRidesCount || 0);

    if (current === expected) {
      continue;
    }

    changed += 1;
    console.log(`  ${String(driver.name || driver._id).padEnd(24)} ${current} -> ${expected}`);

    if (apply) {
      await drivers.updateOne({ _id: driver._id }, { $set: { completedRidesCount: expected } });
    }
  }

  console.log(`\n${allDrivers.length} drivers checked, ${changed} ${apply ? 'updated' : 'would change'}.`);

  if (!apply && changed) {
    console.log('Dry run. Re-run with --apply to write.');
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
