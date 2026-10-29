import { Driver } from '../models/Driver.js';
import { getDriverRoom, getSocketServer } from '../../services/dispatchService.js';
import { sendPushNotificationToEntities } from '../../services/pushNotificationService.js';
import {
  buildDriverTodaySummaryFromDocument,
  mergeOnlineSessionIntoTracking,
} from './driverTodaySummaryService.js';

/**
 * Ghost drivers: a phone that is switched off or lost its connection leaves the
 * driver "online", so dispatch keeps offering them rides nobody will answer.
 *
 * A driver counts as alive while their app has a socket open, or has sent a
 * location update or a heartbeat within the timeout. The app keeps itself alive
 * in the background by calling POST /drivers/heartbeat. A driver on a ride is
 * never touched.
 *
 * DRIVER_PRESENCE_TIMEOUT_SECONDS (default 300) and DRIVER_PRESENCE_SWEEP_ENABLED
 * (default on) tune it.
 */

const SWEEP_INTERVAL_MS = 60 * 1000;

export const driverPresenceConfig = () => ({
  enabled: String(process.env.DRIVER_PRESENCE_SWEEP_ENABLED ?? 'true').toLowerCase() !== 'false',
  timeoutMs: Math.max(60, Number(process.env.DRIVER_PRESENCE_TIMEOUT_SECONDS) || 300) * 1000,
});

const pruneClaimedRewards = (items = []) =>
  (Array.isArray(items) ? items : [])
    .filter((item) => item?.rewardType && item?.rewardKey)
    .sort((left, right) => new Date(left.claimedAt || 0) - new Date(right.claimedAt || 0))
    .slice(-200);

export const touchDriverPresence = (driverId, extra = {}) =>
  Driver.updateOne({ _id: driverId }, { $set: { lastSeenAt: new Date(), ...extra } });

const hasLiveSocket = async (driverId) => {
  const io = getSocketServer();
  if (!io) return false;
  const sockets = await io.in(getDriverRoom(String(driverId))).fetchSockets();
  return sockets.length > 0;
};

export const sweepGhostDrivers = async (now = new Date()) => {
  const { timeoutMs } = driverPresenceConfig();
  const cutoff = new Date(now.getTime() - timeoutMs);
  const candidates = await Driver.find({
    isOnline: true,
    isOnRide: { $ne: true },
    deletedAt: null,
    $or: [{ lastSeenAt: { $lt: cutoff } }, { lastSeenAt: null }],
  })
    .select('_id lastSeenAt incentiveTracking todaySummary')
    .limit(500);

  const wentOffline = [];
  for (const driver of candidates) {
    if (await hasLiveSocket(driver._id)) {
      await touchDriverPresence(driver._id);
      continue;
    }

    const tracking = mergeOnlineSessionIntoTracking(
      driver.incentiveTracking || {},
      driver.incentiveTracking?.currentOnlineStartedAt,
      now,
    );
    // Only if nothing changed since we read it: a heartbeat or a new ride wins.
    const result = await Driver.updateOne(
      { _id: driver._id, isOnline: true, isOnRide: { $ne: true }, lastSeenAt: driver.lastSeenAt ?? null },
      {
        $set: {
          isOnline: false,
          socketId: null,
          incentiveTracking: {
            ...tracking,
            currentOnlineStartedAt: null,
            claimedRewards: pruneClaimedRewards(tracking?.claimedRewards),
          },
          todaySummary: buildDriverTodaySummaryFromDocument(driver, { now }),
        },
      },
    );
    if (result.modifiedCount) wentOffline.push(String(driver._id));
  }

  if (wentOffline.length) {
    console.log(`[presence] took ${wentOffline.length} unreachable driver(s) offline`);
    sendPushNotificationToEntities({
      driverIds: wentOffline,
      title: 'You are offline',
      body: 'We lost contact with your app, so you were taken offline. Go online again to get rides.',
      data: { type: 'driver_auto_offline' },
    }).catch((error) => console.error('[presence] offline push failed', error));
  }

  return wentOffline;
};

let sweepTimer = null;

export const startDriverPresenceSweep = () => {
  const { enabled, timeoutMs } = driverPresenceConfig();
  if (!enabled || sweepTimer) return;

  // After a restart every app needs a moment to reconnect, so the first sweep
  // waits one full timeout.
  const startedAt = Date.now();
  sweepTimer = setInterval(() => {
    if (Date.now() - startedAt < timeoutMs) return;
    sweepGhostDrivers().catch((error) => console.error('[presence] sweep failed', error));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
};
