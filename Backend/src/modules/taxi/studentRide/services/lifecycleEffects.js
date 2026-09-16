/**
 * What else happens when a student ride changes status: push to the parent,
 * the tracking link to guardians, and share links closed at the end.
 *
 * Called from two places — the dispatch sync and the module's own transitions —
 * always after the change has been saved, and never awaited into the caller. The
 * sync runs inside the dispatch engine, so a slow SMS gateway or a push outage
 * here must not delay a driver's status update, let alone fail it.
 *
 * Every dependency is resolved at call time. A static import of shareService
 * would run through studentRideService and fareService back into rideService,
 * which is one of this module's callers.
 */

const PARENT_MESSAGES = Object.freeze({
  DRIVER_ASSIGNED: (name) => ({ title: 'Driver assigned', body: `A driver is on the way to collect ${name}.` }),
  DRIVER_ARRIVED: () => ({ title: 'Driver has arrived', body: 'The driver has reached the pickup point.' }),
  RIDE_STARTED: (name) => ({ title: `${name} is on the way`, body: 'The trip has started. Tap to track it live.' }),
  COMPLETED: (name) => ({ title: `${name} has arrived`, body: 'The trip is complete.' }),
  CANCELLED: () => ({ title: 'Ride cancelled', body: 'The student ride was cancelled.' }),
});

const TERMINAL = ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'FAILED'];

const firstName = (student) => String(student?.name || '').trim().split(/\s+/)[0] || 'Your child';

/**
 * Send the tracking link to guardians as the journey starts.
 *
 * Previously guardians only heard anything if the parent tapped Share. The
 * legacy auto-SMS path reads `studentSafety.isStudentRide`, which the module's
 * booking never sets, so it did not fire for a real student ride either — and it
 * is deliberately not revived here, being the legacy system.
 */
const shareWithGuardians = async ({ studentRide, student }) => {
  const [{ createShareLink }, { listEmergencyContacts }, { sendTrackingLinkToGuardians }] = await Promise.all([
    import('./shareService.js'),
    import('./guardianService.js'),
    import('./studentRideNotifications.js'),
  ]);

  const contacts = await listEmergencyContacts(studentRide.studentId);

  // No guardian on file means no link is minted: a token nobody holds is only
  // something that could leak.
  if (!contacts.length) {
    return;
  }

  const share = await createShareLink({
    studentRideId: studentRide._id,
    userId: studentRide.userId,
  });

  await sendTrackingLinkToGuardians({
    contacts,
    studentName: firstName(student),
    shareUrl: share.shareUrl,
  });
};

const run = async ({ studentRide, statuses }) => {
  if (!studentRide?._id || !statuses?.length) {
    return;
  }

  const [{ Student }, { notifyParent }] = await Promise.all([
    import('../models/Student.js'),
    import('./studentRideNotifications.js'),
  ]);

  const student = await Student.findById(studentRide.studentId).select('name');
  const name = firstName(student);

  // Only the furthest status is pushed. A walk that crosses several steps at once
  // would otherwise buzz the parent's phone once per step within a second.
  const notable = [...statuses].reverse().find((status) => PARENT_MESSAGES[status]);

  if (notable) {
    const message = PARENT_MESSAGES[notable](name);

    await notifyParent({
      userId: studentRide.userId,
      title: message.title,
      body: message.body,
      data: {
        type: 'student_ride_status',
        studentRideId: String(studentRide._id),
        status: notable,
      },
    });
  }

  if (statuses.includes('RIDE_STARTED')) {
    await shareWithGuardians({ studentRide, student }).catch((error) => {
      console.error('[student-ride] guardian tracking link failed', error?.message || error);
    });
  }

  // A finished ride's share links are closed outright. resolveToken already
  // refuses a finished ride, so this is not closing a leak — it stops tokens
  // outliving the journey they were issued for.
  if (statuses.some((status) => TERMINAL.includes(status))) {
    const { revokeAllShareLinks } = await import('./shareService.js');
    await revokeAllShareLinks({ studentRideId: studentRide._id });
  }
};

export const applyLifecycleEffects = ({ studentRide, statuses }) => {
  run({ studentRide, statuses }).catch((error) => {
    console.error('[student-ride] lifecycle effects failed', error?.message || error);
  });
};
