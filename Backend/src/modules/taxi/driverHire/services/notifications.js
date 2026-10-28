import { sendPushNotificationToEntities } from '../../services/pushNotificationService.js';

/**
 * Search a Driver push notifications, through the platform's FCM service.
 *
 * Bodies carry no addresses, codes or phone numbers (spec §5): a lock screen is
 * not private. The app fetches the booking for details.
 */
const EVENTS = {
  // Customer
  DRIVER_ASSIGNED: { to: 'customer', title: 'Driver assigned', body: () => 'A verified driver has accepted your booking.' },
  DRIVER_EN_ROUTE: { to: 'customer', title: 'Driver on the way', body: () => 'Your driver is on the way to your pickup.' },
  DRIVER_ARRIVED: { to: 'customer', title: 'Driver has arrived', body: () => 'Your driver is at the pickup. Share your start code when you are ready.' },
  TRIP_STARTED: { to: 'customer', title: 'Trip started', body: () => 'Your trip has started.' },
  TRIP_COMPLETED: { to: 'customer', title: 'Trip completed', body: () => 'Your trip is complete. View the receipt and rate your driver.' },
  DRIVER_RELEASED: { to: 'customer', title: 'Finding another driver', body: () => 'Your driver had to cancel. We are finding you another verified driver.' },
  CANCELLED_BY_DRIVER: { to: 'customer', title: 'Booking cancelled', body: () => 'Your driver cancelled and no replacement could be arranged in time.' },
  CANCELLED_BY_ADMIN: { to: 'both', title: 'Booking cancelled', body: () => 'This booking was cancelled by Yushi Go support.' },
  EXPIRED: { to: 'customer', title: 'No driver found', body: () => 'We could not find a driver for your booking. You have not been charged.' },
  // Driver
  OFFER: { to: 'driver', title: 'New booking request', body: () => 'You have a new Search a Driver request. Respond before it expires.' },
  CANCELLED_BY_CUSTOMER: { to: 'driver', title: 'Booking cancelled', body: () => 'The customer cancelled this booking.' },
  LICENCE_EXPIRING: { to: 'driver', title: 'Licence expiring soon', body: ({ days }) => `Your driving licence expires in ${days} day${days === 1 ? '' : 's'}. Upload a renewed licence to keep receiving bookings.` },
  PROFILE_APPROVED: { to: 'driver', title: 'Profile approved', body: () => 'You can now go online for Search a Driver bookings.' },
  PROFILE_REJECTED: { to: 'driver', title: 'Profile needs changes', body: () => 'Your Search a Driver profile was not approved. Open the app to see why.' },
  PROFILE_SUSPENDED: { to: 'driver', title: 'Profile suspended', body: () => 'Your Search a Driver profile is suspended. Contact support for details.' },
};

/**
 * Fire-and-forget: a push failure must never roll back or block a booking
 * change that is already committed.
 */
export const notifyDriverHire = (type, { booking = null, driverId = null, customerId = null, ...context } = {}) => {
  const event = EVENTS[type];
  if (!event) return;

  const customer = String(customerId || booking?.customerId?._id || booking?.customerId || '');
  const driver = String(driverId || booking?.driverId?._id || booking?.driverId || '');
  const userIds = ['customer', 'both'].includes(event.to) && customer ? [customer] : [];
  const driverIds = ['driver', 'both'].includes(event.to) && driver ? [driver] : [];
  if (!userIds.length && !driverIds.length) return;

  Promise.resolve()
    .then(() => sendPushNotificationToEntities({
      userIds,
      driverIds,
      title: event.title,
      body: event.body(context),
      data: {
        notification_type: `DRIVER_HIRE_${type}`,
        booking_id: booking ? String(booking._id) : '',
      },
    }))
    .catch((error) => console.error(`[driverHire] ${type} notification failed`, error?.message || error));
};
