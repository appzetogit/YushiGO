import { sendPushNotificationToEntities } from '../../services/pushNotificationService.js';

/**
 * Carpool notification events (§34), delivered through the platform's existing
 * FCM service. No second notification system.
 *
 * Both parties are ordinary users, so every notification targets `userIds` —
 * there is no driver account to address.
 */
const EVENTS = {
  CARPOOL_RIDE_REQUEST: {
    to: 'host',
    title: 'New seat request',
    body: ({ booking }) => `Someone requested ${booking.seatCount} seat(s) on your ride.`,
  },
  CARPOOL_OFFER_RECEIVED: {
    to: 'host',
    title: 'New seat request with an offer',
    body: ({ booking }) => `Someone offered ₹${booking.offeredPrice} per seat${booking.isDoorToDoor ? ' for a door-to-door trip' : ''}.`,
  },
  CARPOOL_REQUEST_ACCEPTED: {
    to: 'passenger',
    title: 'Seat confirmed',
    body: () => 'Your carpool seat request was accepted.',
  },
  CARPOOL_REQUEST_REJECTED: {
    to: 'passenger',
    title: 'Request declined',
    body: () => 'Your carpool seat request was declined.',
  },
  CARPOOL_BOOKING_CANCELLED: {
    to: 'host',
    title: 'Booking cancelled',
    body: ({ booking }) => `A passenger cancelled ${booking.seatCount} seat(s).`,
  },
  CARPOOL_RIDE_CANCELLED: {
    to: 'passenger',
    title: 'Ride cancelled',
    body: () => 'The host cancelled this carpool ride.',
  },
  CARPOOL_RIDE_STARTED: {
    to: 'passenger',
    title: 'Ride started',
    body: () => 'Your carpool ride has started.',
  },
  CARPOOL_REQUEST_EXPIRED: {
    to: 'passenger',
    title: 'Request expired',
    body: () => 'The ride departed before the host answered your seat request.',
  },
  CARPOOL_RIDE_EXPIRED: {
    to: 'passenger',
    title: 'Ride did not start',
    body: () => 'The host did not start this carpool ride, so your booking was cancelled.',
  },
  CARPOOL_RIDE_COMPLETED: {
    to: 'passenger',
    title: 'Ride completed',
    body: () => 'Your carpool ride is complete. Rate your host.',
  },
};

/**
 * Fire-and-forget by design: a push failure must never roll back or block a
 * booking that is already committed.
 */
export const notifyCarpool = async (type, { ride = null, booking = null } = {}) => {
  const event = EVENTS[type];

  if (!event || !booking) {
    return;
  }

  const recipientId = event.to === 'host'
    ? String(booking.driverId?._id || booking.driverId || ride?.driverId || '')
    : String(booking.passengerId?._id || booking.passengerId || '');

  if (!recipientId) {
    return;
  }

  try {
    await sendPushNotificationToEntities({
      userIds: [recipientId],
      title: event.title,
      body: event.body({ booking, ride }),
      data: {
        notification_type: type,
        ride_id: String(booking.rideId?._id || booking.rideId || ride?._id || ''),
        booking_id: String(booking._id || ''),
      },
    });
  } catch (error) {
    console.error(`[carpool] ${type} notification failed`, error?.message || error);
  }
};
