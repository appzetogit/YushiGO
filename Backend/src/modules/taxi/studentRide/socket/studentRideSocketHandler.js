import { StudentRide } from '../models/StudentRide.js';
import { resolveShareTokenForSocket } from '../services/shareService.js';
import { getStudentRideRoom } from './emitters.js';

// Re-exported so existing importers keep working; the emitters themselves live
// in a dependency-free module the dispatch engine can also call.
export { getStudentRideRoom, emitStudentRideStatus } from './emitters.js';

/**
 * Live tracking for a student ride, for two very different audiences (§34).
 *
 * The parent's app connects with a JWT like any other client. The guardian who
 * received a forwarded link has no account at all and connects with the share
 * token instead — so that path is kept deliberately narrow: it can join exactly
 * one room, it is never given a room name it did not already hold a token for,
 * and it can emit nothing.
 */
export const SHARE_VIEWER_ROLE = 'share-viewer';

/**
 * Authorise a browser holding only a share token.
 *
 * Called from the socket auth middleware before any handler runs. Returns the
 * single ride the connection may watch, or throws — an expired, revoked or
 * finished token is refused here rather than after a room has been joined.
 */
export const authorizeShareViewer = async (shareToken) => {
  const { studentRideId } = await resolveShareTokenForSocket(shareToken);

  return { role: SHARE_VIEWER_ROLE, sub: null, studentRideId };
};

/**
 * Wire up a share-viewer connection.
 *
 * Registered instead of — never alongside — the authenticated handlers, so a
 * token holder cannot reach ride chat, dispatch events or anyone else's rooms.
 */
export const registerShareViewerHandlers = ({ socket }) => {
  const { studentRideId } = socket.auth;

  socket.join(getStudentRideRoom(studentRideId));
  socket.emit('student-ride:joined', { studentRideId: String(studentRideId) });

  // No inbound events are registered at all: a watcher watches. Anything this
  // socket emits is silently ignored rather than handled.
};

/** Handlers for the authenticated parent app. */
export const registerStudentRideSocketHandlers = ({ socket, onAsync }) => {
  const identity = socket.auth || {};

  socket.on(
    'student-ride:join',
    onAsync(socket, async ({ studentRideId }) => {
      if (!studentRideId) {
        return;
      }

      const ride = await StudentRide.findById(studentRideId).select('userId status rideId');

      // Ownership is resolved server-side; an id alone grants nothing.
      if (!ride || String(ride.userId) !== String(identity.sub)) {
        socket.emit('student-ride:error', { message: 'Ride not found.' });
        return;
      }

      socket.join(getStudentRideRoom(studentRideId));

      /**
       * Also join the dispatch ride's room, where the driver's position is
       * already broadcast.
       *
       * The alternative was a second location event for student rides, which
       * meant looking up the companion on every GPS ping — several per second
       * across the fleet — to publish bytes the existing stream already carries.
       * One extra room join at subscribe time costs nothing and means the app
       * never has to know the dispatch ride exists.
       */
      if (ride.rideId) {
        socket.join(`ride_${ride.rideId}`);
      }

      socket.emit('student-ride:joined', {
        studentRideId: String(studentRideId),
        status: ride.status,
        // Named so the client can correlate ride:driver-location:updated events.
        rideId: ride.rideId ? String(ride.rideId) : null,
      });
    }),
  );

  socket.on(
    'student-ride:leave',
    onAsync(socket, async ({ studentRideId }) => {
      if (!studentRideId) {
        return;
      }

      socket.leave(getStudentRideRoom(studentRideId));

      const ride = await StudentRide.findById(studentRideId).select('rideId');

      if (ride?.rideId) {
        socket.leave(`ride_${ride.rideId}`);
      }
    }),
  );
};
