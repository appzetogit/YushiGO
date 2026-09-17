/**
 * Local wall-clock time → the instant it names.
 *
 * The host types a date and time in their own calendar and the app sends exactly
 * that, with no offset. Stamping a `Z` on it stored every IST ride 5h30 in the
 * future, which kept departed rides searchable and bookable for hours.
 *
 * One market timezone for now. The offset is derived per date through Intl
 * rather than fixed once, so a zone with daylight saving is still right.
 */

export const carpoolTimeZone = () => process.env.CARPOOL_TIMEZONE || 'Asia/Kolkata';

const formatterCache = new Map();

const formatterFor = (timeZone) => {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }));
  }

  return formatterCache.get(timeZone);
};

/** Wall-clock parts of an instant in a zone. */
export const wallClockParts = (instant, timeZone = carpoolTimeZone()) => {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );

  return parts;
};

/** Milliseconds the zone is ahead of UTC at a given instant. */
const offsetAt = (instantMs, timeZone) => {
  const p = wallClockParts(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
};

/**
 * `YYYY-MM-DD` + `HH:mm` in `timeZone` → Date, or null when the pair does not
 * name a real calendar time (30 Feb, 25:00).
 */
export const zonedWallClockToUtc = (rawDate, rawTime, timeZone = carpoolTimeZone()) => {
  const [year, month, day] = rawDate.split('-').map(Number);
  const [hour, minute] = rawTime.split(':').map(Number);

  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const check = new Date(wallAsUtc);

  if (
    Number.isNaN(wallAsUtc)
    || check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
    || check.getUTCHours() !== hour
    || check.getUTCMinutes() !== minute
  ) {
    return null;
  }

  // Two passes: the first offset is taken at a guess that can sit on the other
  // side of a DST change from the real instant; the second corrects it.
  let instant = wallAsUtc - offsetAt(wallAsUtc, timeZone);
  instant = wallAsUtc - offsetAt(instant, timeZone);

  return new Date(instant);
};

/** Today's date in the market zone, as `YYYY-MM-DD`. */
export const todayInZone = (timeZone = carpoolTimeZone(), now = new Date()) => {
  const p = wallClockParts(now, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};
