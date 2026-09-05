import { StudentRide } from '../models/StudentRide.js';
import { resolveShareTokenForSocket } from '../services/shareService.js';

/**
 * Live tracking for a student ride, for two very different audiences (§34).
 *
 * The parent's app connects with a JWT like any other client. The guardian who
 * received a forwarded link has no account at all and connects with the share
 * token instead — so that path is kept deliberately narrow: it can join exactly
 * one room, it is never given a room name it did not already hold a token for,
 * and it can emit nothing.
 */
export const getStudentRideRoom = (studentRideId) => `student_ride:${studentRideId}`;

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
 * What a share viewer is sent.
 *
 * Location and status only. The identifying detail a watcher needs already came
 * from the public REST payload; repeating it on every position update would put
 * it on the wire far more often than necessary.
 */
const publicLocationEvent = ({ studentRideId, latitude, longitude, heading, speed }) => ({
  studentRideId: String(studentRideId),
  latitude,
  longitude,
  heading: Number.isFinite(Number(heading)) ? Number(heading) : null,
  speed: Number.isFinite(Number(speed)) ? Number(speed) : null,
  timestamp: new Date().toISOString(),
});

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

      const ride = await StudentRide.findById(studentRideId).select('userId status');

      // Ownership is resolved server-side; an id alone grants nothing.
      if (!ride || String(ride.userId) !== String(identity.sub)) {
        socket.emit('student-ride:error', { message: 'Ride not found.' });
        return;
      }

      socket.join(getStudentRideRoom(studentRideId));
      socket.emit('student-ride:joined', {
        studentRideId: String(studentRideId),
        status: ride.status,
      });
    }),
  );

  socket.on(
    'student-ride:leave',
    onAsync(socket, async ({ studentRideId }) => {
      if (studentRideId) {
        socket.leave(getStudentRideRoom(studentRideId));
      }
    }),
  );
};

/**
 * Relay the assigned driver's position to everyone watching this student ride.
 *
 * Fed from the dispatch location pipeline rather than from a second stream of
 * GPS: the driver app already pushes position for the underlying ride, and
 * duplicating that would double the traffic and let the two disagree.
 */
export const emitStudentRideLocation = (io, { studentRideId, latitude, longitude, heading, speed }) => {
  if (!io || !studentRideId) {
    return;
  }

  io.to(getStudentRideRoom(studentRideId)).emit(
    'student-ride:location:updated',
    publicLocationEvent({ studentRideId, latitude, longitude, heading, speed }),
  );
};

/** Announce a status change, and tell watchers when to stop watching (§34). */
export const emitStudentRideStatus = (io, ride) => {
  if (!io || !ride) {
    return;
  }

  const room = getStudentRideRoom(ride._id);
  const terminal = ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'FAILED'].includes(ride.status);

  io.to(room).emit('student-ride:status:updated', {
    studentRideId: String(ride._id),
    status: ride.status,
  });

  if (terminal) {
    io.to(room).emit('student-ride:completed', {
      studentRideId: String(ride._id),
      status: ride.status,
    });

    // Watchers are disconnected from the room as the journey ends, so a stale
    // page cannot keep receiving anything after tracking should have stopped.
    io.in(room).socketsLeave(room);
  }
};
