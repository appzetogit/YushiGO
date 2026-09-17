/**
 * Recompute carpool departureAt in the market timezone, and backfill expiresAt.
 *
 *   node scripts/migrateCarpoolDepartureTimes.js            # dry run, prints the plan
 *   node scripts/migrateCarpoolDepartureTimes.js --apply    # writes it
 *
 * departureAt used to be the host's local date and time stamped as UTC, so every
 * IST ride was stored 5h30 late. This recomputes it from the `date` and
 * `departureTime` strings the host actually typed, which were always stored
 * verbatim, so it is idempotent: a second run changes nothing.
 *
 * Run it before the expiry sweep goes live. A sweep over skewed values would
 * expire the wrong set of rides.
 */
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { zonedWallClockToUtc, carpoolTimeZone } from '../src/modules/taxi/carpool/services/departureTime.js';
import { carpoolConfig } from '../src/modules/taxi/carpool/constants/index.js';

export const migrateCarpoolDepartureTimes = async ({ apply = false, log = console.log } = {}) => {
  const rides = mongoose.connection.collection('taxicarpoolrides');
  const graceMs = carpoolConfig().expiryGraceMinutes * 60_000;
  const timeZone = carpoolTimeZone();

  const cursor = rides.find({}, {
    projection: { _id: 1, date: 1, departureTime: 1, departureAt: 1, expiresAt: 1, status: 1 },
  });

  const summary = { scanned: 0, changed: 0, unparseable: 0, wouldExpire: 0 };
  const now = Date.now();

  for await (const ride of cursor) {
    summary.scanned += 1;

    const departureAt = zonedWallClockToUtc(String(ride.date || ''), String(ride.departureTime || ''), timeZone);

    if (!departureAt) {
      summary.unparseable += 1;
      log(`  skip ${ride._id}: cannot read "${ride.date} ${ride.departureTime}"`);
      continue;
    }

    const expiresAt = new Date(departureAt.getTime() + graceMs);

    if (['PUBLISHED', 'FULL'].includes(ride.status) && expiresAt.getTime() <= now) {
      summary.wouldExpire += 1;
    }

    const same = ride.departureAt?.getTime?.() === departureAt.getTime()
      && ride.expiresAt?.getTime?.() === expiresAt.getTime();

    if (same) {
      continue;
    }

    summary.changed += 1;
    log(`  ${ride._id} [${ride.status}] ${ride.date} ${ride.departureTime}: `
      + `${ride.departureAt?.toISOString?.() || 'none'} -> ${departureAt.toISOString()}`);

    if (apply) {
      await rides.updateOne({ _id: ride._id }, { $set: { departureAt, expiresAt } });
    }
  }

  return summary;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  dotenv.config();
  const apply = process.argv.includes('--apply');

  try {
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
    const summary = await migrateCarpoolDepartureTimes({ apply });
    console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'} (timezone ${carpoolTimeZone()})`, summary);
    if (!apply) console.log('Re-run with --apply to write.');
  } finally {
    await mongoose.disconnect();
  }
}
