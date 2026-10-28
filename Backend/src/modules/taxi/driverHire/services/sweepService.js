import {
  DRIVER_HIRE_PROFILE_STATUS,
  DRIVER_HIRE_SERVICE_TYPES,
  DRIVER_HIRE_STATUS,
  driverHireConfig,
} from '../constants/index.js';
import { DriverHireBooking } from '../models/DriverHireBooking.js';
import { DriverHireProfile } from '../models/DriverHireProfile.js';
import { notifyDriverHire } from './notifications.js';
import { transition } from './stateMachine.js';

/**
 * Housekeeping on a timer:
 *   - offers nobody answered go back to the pool (the driver counts as declined);
 *   - bookings nobody took by their pickup time (plus grace) expire — no charge;
 *   - drivers hear about a licence expiring before it stops their bookings.
 *
 * Every change is a conditional update, so overlapping sweeps (two server
 * processes) do each thing once.
 */

const SYSTEM = { role: 'system', id: null };

export const expireStaleOffers = async (now = new Date()) => {
  const stale = await DriverHireBooking.find({
    status: DRIVER_HIRE_STATUS.REQUESTED,
    'offer.driverId': { $ne: null },
    'offer.expiresAt': { $lte: now },
  }).select('_id offer').limit(200).lean();

  let count = 0;
  for (const booking of stale) {
    const result = await DriverHireBooking.updateOne(
      { _id: booking._id, status: DRIVER_HIRE_STATUS.REQUESTED, 'offer.driverId': booking.offer.driverId, 'offer.expiresAt': { $lte: now } },
      {
        $set: { 'offer.driverId': null, 'offer.offeredAt': null, 'offer.expiresAt': null, 'offer.offeredBy': null },
        $push: {
          declinedDriverIds: booking.offer.driverId,
          timeline: { status: DRIVER_HIRE_STATUS.REQUESTED, event: 'OFFER_TIMED_OUT', at: now, actorRole: 'system', actorId: booking.offer.driverId },
        },
      },
    );
    count += result.modifiedCount;
  }
  return count;
};

export const expireUnassignedBookings = async (now = new Date()) => {
  const config = driverHireConfig();
  const scheduledCutoff = new Date(now.getTime() - config.noDriverGraceMinutes * 60000);
  const nowCutoff = new Date(now.getTime() - config.nowSearchMinutes * 60000);

  const due = await DriverHireBooking.find({
    status: DRIVER_HIRE_STATUS.REQUESTED,
    $or: [
      { serviceType: DRIVER_HIRE_SERVICE_TYPES.NOW, scheduledAt: { $lte: nowCutoff } },
      { serviceType: { $ne: DRIVER_HIRE_SERVICE_TYPES.NOW }, scheduledAt: { $lte: scheduledCutoff } },
    ],
  }).select('_id').limit(200).lean();

  let count = 0;
  for (const { _id } of due) {
    try {
      const booking = await transition({
        bookingId: _id,
        from: [DRIVER_HIRE_STATUS.REQUESTED],
        to: DRIVER_HIRE_STATUS.EXPIRED,
        actor: SYSTEM,
        note: 'No driver found',
        set: { 'offer.driverId': null, 'offer.expiresAt': null },
      });
      count += 1;
      notifyDriverHire('EXPIRED', { booking });
    } catch (error) {
      // Assigned in the meantime: not ours to expire.
      if (error.code !== 'INVALID_TRANSITION') throw error;
    }
  }
  return count;
};

export const sendLicenceReminders = async (now = new Date()) => {
  let sent = 0;
  for (const days of driverHireConfig().licenceReminderDays) {
    const horizon = new Date(now.getTime() + days * 86400000);
    const profiles = await DriverHireProfile.find({
      verificationStatus: DRIVER_HIRE_PROFILE_STATUS.APPROVED,
      licenceExpiry: { $gt: now, $lte: horizon },
      licenceRemindersSent: { $ne: days },
    }).select('_id driverId licenceExpiry').limit(500).lean();

    for (const profile of profiles) {
      const claimed = await DriverHireProfile.updateOne(
        { _id: profile._id, licenceRemindersSent: { $ne: days } },
        { $addToSet: { licenceRemindersSent: days } },
      );
      if (!claimed.modifiedCount) continue;
      const left = Math.max(1, Math.ceil((new Date(profile.licenceExpiry).getTime() - now.getTime()) / 86400000));
      notifyDriverHire('LICENCE_EXPIRING', { driverId: profile.driverId, days: left });
      sent += 1;
    }
  }

  // An expired licence takes the driver offline straight away.
  await DriverHireProfile.updateMany({ isOnline: true, licenceExpiry: { $lte: now } }, { $set: { isOnline: false } });
  return sent;
};

export const runDriverHireSweep = async (now = new Date()) => ({
  offersTimedOut: await expireStaleOffers(now),
  bookingsExpired: await expireUnassignedBookings(now),
  licenceReminders: await sendLicenceReminders(now),
});

let timer = null;

export const startDriverHireSweep = () => {
  const config = driverHireConfig();
  if (!config.sweepEnabled || timer) return;
  timer = setInterval(() => {
    runDriverHireSweep().catch((error) => console.error('[driverHire] sweep failed', error?.message || error));
  }, config.sweepIntervalMinutes * 60000);
  timer.unref?.();
};
