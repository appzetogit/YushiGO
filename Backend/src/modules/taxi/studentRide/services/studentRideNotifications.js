import { sendPushNotificationToEntities } from '../../services/pushNotificationService.js';
import { sendGuardianTrackingSms } from '../../services/smsService.js';

/**
 * Student-ride notifications, delivered through the platform's existing FCM and
 * SMS services (§40). No second notification system.
 *
 * Guardians are reached by SMS rather than push: they may have no app at all,
 * which is the whole premise of the shared browser link.
 */

/** Send the tracking link to every guardian marked as an emergency contact. */
export const sendTrackingLinkToGuardians = async ({ contacts, studentName, shareUrl }) => {
  if (!shareUrl || !contacts?.length) {
    return 0;
  }

  const message = `${studentName || 'Your child'}'s ride has started. Track it live: ${shareUrl}`;

  const results = await Promise.allSettled(
    contacts.map((contact) => sendGuardianTrackingSms({ phone: contact.mobile, message })),
  );

  return results.filter((result) => result.status === 'fulfilled').length;
};

/**
 * Fan an SOS out to guardians.
 *
 * Returns how many were reached so the emergency record can show it; a delivery
 * failure is counted rather than thrown, because the alert itself is already
 * committed and must not be undone by an SMS outage.
 */
export const notifyEmergencyContacts = async ({ emergency, student, contacts }) => {
  const name = student?.name || 'A student';
  const where = emergency.latitude && emergency.longitude
    ? ` Last known location: https://maps.google.com/?q=${emergency.latitude},${emergency.longitude}`
    : '';

  const message = `EMERGENCY: an SOS was raised during ${name}'s ride.${where}`;

  const results = await Promise.allSettled(
    (contacts || []).map((contact) => sendGuardianTrackingSms({ phone: contact.mobile, message })),
  );

  return results.filter((result) => result.status === 'fulfilled').length;
};

/** Push to the parent's app for ordinary ride progress. */
export const notifyParent = async ({ userId, title, body, data = {} }) => {
  if (!userId) {
    return;
  }

  try {
    await sendPushNotificationToEntities({
      userIds: [String(userId)],
      title,
      body,
      data,
    });
  } catch (error) {
    console.error('[student-ride] notification failed', error?.message || error);
  }
};
