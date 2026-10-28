import { getFirebaseMessaging } from '../../../config/firebase.js';
import { Driver } from '../driver/models/Driver.js';
import { User } from '../user/models/User.js';
import { listEntityPushTokens } from './pushTokenService.js';

const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
]);

const chunk = (items, size) => {
  const groups = [];

  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }

  return groups;
};

const collectAudienceTargets = async ({ sendTo, serviceLocationId }) => {
  const includeUsers = sendTo === 'all' || sendTo === 'users';
  const includeDrivers = sendTo === 'all' || sendTo === 'drivers';
  const targets = [];

  if (includeUsers) {
    const users = await User.find({
      deletedAt: null,
      isActive: { $ne: false },
      active: { $ne: false },
    })
      .select('_id fcmTokenWeb fcmTokenMobile')
      .lean();

    users.forEach((user) => {
      listEntityPushTokens(user, 'user').forEach((tokenEntry) => {
        targets.push({
          ...tokenEntry,
          entityId: String(user._id),
        });
      });
    });
  }

  if (includeDrivers) {
    const driverQuery = {
      deletedAt: null,
      approve: { $ne: false },
      status: { $ne: 'pending' },
    };

    if (serviceLocationId) {
      driverQuery.service_location_id = serviceLocationId;
    }

    const drivers = await Driver.find(driverQuery)
      .select('_id fcmTokenWeb fcmTokenMobile')
      .lean();

    drivers.forEach((driver) => {
      listEntityPushTokens(driver, 'driver').forEach((tokenEntry) => {
        targets.push({
          ...tokenEntry,
          entityId: String(driver._id),
        });
      });
    });
  }

  return targets;
};

const removeInvalidTokens = async (invalidTargets = []) => {
  if (invalidTargets.length === 0) {
    return 0;
  }

  const userIdsByField = { fcmTokenWeb: new Set(), fcmTokenMobile: new Set() };
  const driverIdsByField = { fcmTokenWeb: new Set(), fcmTokenMobile: new Set() };

  invalidTargets.forEach((target) => {
    if (target.role === 'user') {
      userIdsByField[target.field]?.add(target.entityId);
    }

    if (target.role === 'driver') {
      driverIdsByField[target.field]?.add(target.entityId);
    }
  });

  const operations = [];

  Object.entries(userIdsByField).forEach(([field, ids]) => {
    if (ids.size > 0) {
      operations.push(
        User.updateMany(
          { _id: { $in: Array.from(ids) } },
          { $set: { [field]: '' } },
        ),
      );
    }
  });

  Object.entries(driverIdsByField).forEach(([field, ids]) => {
    if (ids.size > 0) {
      operations.push(
        Driver.updateMany(
          { _id: { $in: Array.from(ids) } },
          { $set: { [field]: '' } },
        ),
      );
    }
  });

  await Promise.all(operations);
  return invalidTargets.length;
};

const sendPushToTargets = async ({
  targets = [],
  title,
  body,
  image = '',
  data = {},
  // Data-only pushes carry no `notification` block. The driver app's native
  // full-screen ride-offer card is built in RideRequestMessagingService, which
  // Android only calls for data-only messages when the app is in the background
  // or killed; a `notification` block makes FCM draw a plain tray alert instead.
  dataOnly = false,
  ttlSeconds = 0,
}) => {
  const messaging = getFirebaseMessaging();

  if (!messaging) {
    console.warn('[push] Firebase messaging is not configured - push skipped');
    return {
      attempted: false,
      deliveredCount: 0,
      failedCount: 0,
      invalidTokenCount: 0,
      targetCount: 0,
      reason: 'Firebase messaging is not configured on the backend',
    };
  }

  const dedupedTargets = Array.from(
    new Map((Array.isArray(targets) ? targets : []).map((target) => [target.token, target])).values(),
  );

  if (dedupedTargets.length === 0) {
    return {
      attempted: true,
      deliveredCount: 0,
      failedCount: 0,
      invalidTokenCount: 0,
      targetCount: 0,
      reason: 'No saved FCM tokens were found for the selected entities',
    };
  }

  let deliveredCount = 0;
  let failedCount = 0;
  const invalidTargets = [];
  const safeData = Object.fromEntries(
    Object.entries(data || {}).map(([key, value]) => [key, String(value ?? '')]),
  );

  for (const batch of chunk(dedupedTargets, 500)) {
    const response = await messaging.sendEachForMulticast({
      tokens: batch.map((target) => target.token),
      ...(dataOnly
        ? {}
        : {
            notification: {
              title,
              body,
              ...(image ? { imageUrl: image } : {}),
            },
          }),
      data: {
        ...safeData,
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      // Every push goes out at the highest delivery priority so Doze and battery
      // saver do not defer it: FCM `high` on Android, APNs priority 10 on iOS and
      // `Urgency: high` on web push. Data-only pushes (the ride-offer card) skip
      // APNs/web: iOS requires priority 5 for silent pushes, and the card is Android.
      android: {
        priority: 'high',
        ...(ttlSeconds > 0 ? { ttl: ttlSeconds * 1000 } : {}),
        ...(dataOnly
          ? {}
          : {
              notification: {
                priority: 'max',
                defaultSound: true,
                ...(image ? { imageUrl: image } : {}),
              },
            }),
      },
      ...(dataOnly
        ? {}
        : {
            apns: {
              headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
              payload: { aps: { sound: 'default' } },
            },
          }),
      ...(dataOnly
        ? {}
        : {
            webpush: {
              headers: { Urgency: 'high' },
              notification: {
                title,
                body,
                ...(image ? { image } : {}),
              },
            },
          }),
    });

    response.responses.forEach((item, index) => {
      if (item.success) {
        deliveredCount += 1;
        return;
      }

      failedCount += 1;
      // Without this the only symptom of a bad token / wrong Firebase project is
      // a driver who silently never gets a ride request.
      console.warn(
        `[push] send failed role=${batch[index]?.role} entity=${batch[index]?.entityId} code=${item.error?.code} msg=${item.error?.message}`,
      );
      if (INVALID_TOKEN_CODES.has(item.error?.code)) {
        invalidTargets.push(batch[index]);
      }
    });
  }

  const invalidTokenCount = await removeInvalidTokens(invalidTargets);

  return {
    attempted: true,
    deliveredCount,
    failedCount,
    invalidTokenCount,
    targetCount: dedupedTargets.length,
    reason: '',
  };
};

const collectDirectTargets = async ({ userIds = [], driverIds = [] }) => {
  const normalizedUserIds = [...new Set((Array.isArray(userIds) ? userIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
  const normalizedDriverIds = [...new Set((Array.isArray(driverIds) ? driverIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
  const targets = [];

  if (normalizedUserIds.length) {
    const users = await User.find({ _id: { $in: normalizedUserIds } })
      .select('_id fcmTokenWeb fcmTokenMobile')
      .lean();

    users.forEach((user) => {
      listEntityPushTokens(user, 'user').forEach((tokenEntry) => {
        targets.push({
          ...tokenEntry,
          entityId: String(user._id),
        });
      });
    });
  }

  if (normalizedDriverIds.length) {
    const drivers = await Driver.find({ _id: { $in: normalizedDriverIds } })
      .select('_id fcmTokenWeb fcmTokenMobile')
      .lean();

    drivers.forEach((driver) => {
      listEntityPushTokens(driver, 'driver').forEach((tokenEntry) => {
        targets.push({
          ...tokenEntry,
          entityId: String(driver._id),
        });
      });
    });
  }

  return targets;
};

export const sendPushNotificationToAudience = async ({
  notificationId,
  serviceLocationId,
  sendTo,
  title,
  body,
  image,
}) => {
  const messaging = getFirebaseMessaging();

  if (!messaging) {
    return {
      attempted: false,
      deliveredCount: 0,
      failedCount: 0,
      invalidTokenCount: 0,
      targetCount: 0,
      reason: 'Firebase messaging is not configured on the backend',
    };
  }

  const targets = await collectAudienceTargets({ sendTo, serviceLocationId });
  const dedupedTargets = Array.from(
    new Map(targets.map((target) => [target.token, target])).values(),
  );

  if (dedupedTargets.length === 0) {
    return {
      attempted: true,
      deliveredCount: 0,
      failedCount: 0,
      invalidTokenCount: 0,
      targetCount: 0,
      reason: 'No saved FCM tokens were found for the selected audience',
    };
  }

  let deliveredCount = 0;
  let failedCount = 0;
  const invalidTargets = [];

  for (const batch of chunk(dedupedTargets, 500)) {
    const response = await messaging.sendEachForMulticast({
      tokens: batch.map((target) => target.token),
      notification: {
        title,
        body,
        ...(image ? { imageUrl: image } : {}),
      },
      data: {
        notificationId: String(notificationId || ''),
        serviceLocationId: String(serviceLocationId || ''),
        sendTo: String(sendTo || 'all'),
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
        notification: image ? { imageUrl: image } : undefined,
      },
      webpush: {
        notification: {
          title,
          body,
          ...(image ? { image } : {}),
        },
      },
    });

    response.responses.forEach((item, index) => {
      if (item.success) {
        deliveredCount += 1;
        return;
      }

      failedCount += 1;
      if (INVALID_TOKEN_CODES.has(item.error?.code)) {
        invalidTargets.push(batch[index]);
      }
    });
  }

  const invalidTokenCount = await removeInvalidTokens(invalidTargets);

  return {
    attempted: true,
    deliveredCount,
    failedCount,
    invalidTokenCount,
    targetCount: dedupedTargets.length,
    reason: '',
  };
};

export const sendPushNotificationToEntities = async ({
  userIds = [],
  driverIds = [],
  title,
  body,
  image = '',
  data = {},
  dataOnly = false,
  ttlSeconds = 0,
}) => {
  const targets = await collectDirectTargets({ userIds, driverIds });
  if (targets.length === 0) {
    console.warn(
      `[push] no FCM token saved for drivers=[${driverIds.join(',')}] users=[${userIds.join(',')}] type=${data?.type || ''}`,
    );
  }
  return sendPushToTargets({
    targets,
    title,
    body,
    image,
    data,
    dataOnly,
    ttlSeconds,
  });
};
