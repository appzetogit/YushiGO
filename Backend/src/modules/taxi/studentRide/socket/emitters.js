/**
 * Student-ride socket emitters.
 *
 * Deliberately importing nothing. These are called from the dispatch engine's
 * status path, and the handler module they used to live in reaches
 * shareService → studentRideService → fareService → rideService, which is the
 * very module that would be calling them. Keeping the emitters free of
 * dependencies removes that cycle rather than working around it.
 */

export const getStudentRideRoom = (studentRideId) => `student_ride:${studentRideId}`;

/** Statuses after which nothing further will be broadcast for this ride. */
const TERMINAL = ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'FAILED'];

/**
 * Tell everyone watching a ride that its status changed.
 *
 * Takes `io` rather than reaching for it, so the caller decides where the socket
 * server comes from and this stays testable without one.
 */
export const emitStudentRideStatus = (io, ride) => {
  if (!io || !ride?._id) {
    return;
  }

  const room = getStudentRideRoom(ride._id);

  io.to(room).emit('student-ride:status:updated', {
    studentRideId: String(ride._id),
    status: ride.status,
    startedAt: ride.startedAt || null,
    completedAt: ride.completedAt || null,
  });

  if (TERMINAL.includes(ride.status)) {
    io.to(room).emit('student-ride:completed', {
      studentRideId: String(ride._id),
      status: ride.status,
    });

    // Watchers are removed as the journey ends, so a stale page cannot keep
    // receiving updates after tracking should have stopped.
    io.in(room).socketsLeave(room);
  }
};

export const emitStudentRideLocation = (io, { studentRideId, latitude, longitude, heading, speed }) => {
  if (!io || !studentRideId) {
    return;
  }

  io.to(getStudentRideRoom(studentRideId)).emit('student-ride:location:updated', {
    studentRideId: String(studentRideId),
    latitude,
    longitude,
    heading: Number.isFinite(Number(heading)) ? Number(heading) : null,
    speed: Number.isFinite(Number(speed)) ? Number(speed) : null,
    timestamp: new Date().toISOString(),
  });
};
