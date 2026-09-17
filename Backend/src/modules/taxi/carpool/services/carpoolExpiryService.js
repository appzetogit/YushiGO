import { CarpoolRide } from '../models/CarpoolRide.js';
import { CarpoolBooking } from '../models/CarpoolBooking.js';
import {
  CARPOOL_BOOKING_STATUS,
  CARPOOL_RIDE_STATUS,
  carpoolConfig,
} from '../constants/index.js';
import * as settlement from './carpoolSettlement.js';
import { notifyCarpool } from './carpoolNotifications.js';
import { runInTransaction } from './transaction.js';
import { emitCarpoolRideStatus } from '../socket/carpoolSocketHandler.js';

/**
 * Ride expiry: a published ride whose window closed without it starting.
 *
 * Only PUBLISHED and FULL rides expire. A STARTED ride is a trip in progress and
 * is never swept, even long past its window — a host forgetting to press
 * Complete is a different problem from a ride that never happened.
 */
const EXPIRABLE_STATUSES = [CARPOOL_RIDE_STATUS.PUBLISHED, CARPOOL_RIDE_STATUS.FULL];

const PENDING_REASON = 'The ride expired before this request was answered.';
const ACCEPTED_REASON = 'The host did not start this ride.';

export const isPastExpiry = (ride, now = Date.now()) => Boolean(
  ride
  && EXPIRABLE_STATUSES.includes(ride.status)
  && ride.expiresAt
  && new Date(ride.expiresAt).getTime() <= now,
);

/**
 * Expire one ride and resolve its bookings, in a single transaction.
 *
 * The status change is a conditional update, so the ride transitions exactly
 * once: a host starting it a millisecond earlier, or a second sweep in another
 * process, leaves this call matching nothing, and it returns without touching
 * bookings or sending anything.
 *
 * Returns `{ expired: true }` only for the call that made the change.
 */
export const expireRide = async (rideId) => {
  const notifications = [];
  let expiredRide = null;

  await runInTransaction(async (session) => {
    // Cleared per attempt so a retry does not re-queue the previous attempt's work.
    notifications.length = 0;
    expiredRide = null;

    const now = new Date();

    const ride = await CarpoolRide.findOneAndUpdate(
      {
        _id: rideId,
        status: { $in: EXPIRABLE_STATUSES },
        expiresAt: { $lte: now },
      },
      { $set: { status: CARPOOL_RIDE_STATUS.EXPIRED, expiredAt: now, bookedSeats: 0 } },
      { returnDocument: 'after', session },
    );

    if (!ride) {
      return;
    }

    const bookings = await CarpoolBooking.find({
      rideId: ride._id,
      status: { $in: [CARPOOL_BOOKING_STATUS.PENDING, CARPOOL_BOOKING_STATUS.ACCEPTED] },
    }).session(session);

    for (const booking of bookings) {
      if (booking.status === CARPOOL_BOOKING_STATUS.PENDING) {
        booking.status = CARPOOL_BOOKING_STATUS.REJECTED;
        booking.rejectedAt = now;
        booking.cancellationReason = PENDING_REASON;
        notifications.push(['CARPOOL_REQUEST_EXPIRED', { ride, booking }]);
      } else {
        const payment = await settlement.onBookingCancelled({ booking, ride, cancelledBy: 'system' });

        booking.status = CARPOOL_BOOKING_STATUS.CANCELLED;
        booking.paymentStatus = payment.paymentStatus;
        booking.cancelledAt = now;
        booking.cancelledBy = 'system';
        booking.cancellationReason = ACCEPTED_REASON;
        notifications.push(['CARPOOL_RIDE_EXPIRED', { ride, booking }]);
      }

      // Frees the partial unique index, as every other terminal booking path does.
      booking.isActive = false;
      booking.seatsHeld = 0;
      await booking.save({ session });
    }

    expiredRide = ride;
  });

  if (!expiredRide) {
    return { expired: false };
  }

  for (const [type, context] of notifications) {
    await notifyCarpool(type, context);
  }

  // Resolved at call time: the socket server lives in the dispatch service, and
  // nothing else in the expiry path needs that module loaded.
  try {
    const { getSocketServer } = await import('../../services/dispatchService.js');
    emitCarpoolRideStatus(getSocketServer(), expiredRide);
  } catch (error) {
    console.error('[carpool] expiry status emit failed', error?.message || error);
  }

  return { expired: true, rideId: String(expiredRide._id), resolvedBookings: notifications.length };
};

/**
 * One batch of the sweep.
 *
 * Batch-limited so a backlog is worked through over several ticks rather than
 * in one long pass, and each ride is its own short transaction.
 */
export const sweepExpiredRides = async ({ limit = 200 } = {}) => {
  const due = await CarpoolRide.find({
    status: { $in: EXPIRABLE_STATUSES },
    expiresAt: { $lte: new Date() },
  })
    .select('_id')
    .sort({ expiresAt: 1 })
    .limit(limit)
    .lean();

  let expired = 0;

  for (const { _id } of due) {
    try {
      const result = await expireRide(_id);
      expired += result.expired ? 1 : 0;
    } catch (error) {
      // One bad ride must not stop the rest of the batch.
      console.error('[carpool] failed to expire ride', String(_id), error?.message || error);
    }
  }

  return { scanned: due.length, expired };
};

let sweepTimer = null;
let sweepRunning = false;

/**
 * Start the periodic sweep. Carpool-only: it reads and writes nothing but
 * carpool rides and bookings.
 *
 * Safe with several app instances — expireRide's conditional update means a
 * ride two instances reach together is expired once and announced once.
 */
export const startCarpoolExpirySweep = () => {
  const config = carpoolConfig();

  if (!config.expirySweepEnabled || sweepTimer) {
    return;
  }

  const tick = async () => {
    // A slow tick is not overlapped by the next one in the same process.
    if (sweepRunning) {
      return;
    }

    sweepRunning = true;

    try {
      const { expired } = await sweepExpiredRides();

      if (expired) {
        console.log(`[carpool] expired ${expired} ride(s) past their departure window`);
      }
    } catch (error) {
      console.error('[carpool] expiry sweep failed', error?.message || error);
    } finally {
      sweepRunning = false;
    }
  };

  sweepTimer = setInterval(tick, config.expirySweepIntervalMinutes * 60_000);
  // Never the thing keeping the process alive.
  sweepTimer.unref?.();
  tick();
};
