import mongoose from 'mongoose';
import { StudentRideEmergency } from '../models/StudentRideEmergency.js';
import { StudentRide } from '../models/StudentRide.js';
import { Student } from '../models/Student.js';
import {
  STUDENT_RIDE_ERROR_CODES,
  STUDENT_RIDE_EVENTS,
  STUDENT_RIDE_STATUS,
} from '../constants/index.js';
import { studentRideError } from './studentService.js';
import { listEmergencyContacts } from './guardianService.js';
import { recordEvent } from './studentRideService.js';

/** SOS is only meaningful while a journey is actually under way. */
const SOS_ALLOWED_STATUSES = Object.freeze([
  STUDENT_RIDE_STATUS.DRIVER_ARRIVING,
  STUDENT_RIDE_STATUS.DRIVER_ARRIVED,
  STUDENT_RIDE_STATUS.PICKUP_OTP_VERIFIED,
  STUDENT_RIDE_STATUS.RIDE_STARTED,
  STUDENT_RIDE_STATUS.NEAR_DESTINATION,
]);

export const serializeEmergency = (emergency) => ({
  emergencyId: String(emergency._id),
  studentRideId: String(emergency.studentRideId),
  type: emergency.type,
  status: emergency.status,
  latitude: emergency.latitude,
  longitude: emergency.longitude,
  notifiedContacts: emergency.notifiedContacts,
  createdAt: emergency.createdAt,
  resolvedAt: emergency.resolvedAt,
});

/**
 * Raise an SOS.
 *
 * The alert is committed before anyone is notified. Notification depends on SMS
 * and push, both of which can fail or hang; if the record waited on them, the
 * one artefact that proves the alarm was raised could be lost exactly when it
 * matters most.
 */
export const triggerSos = async ({
  studentRideId,
  actor,
  latitude,
  longitude,
  type = 'EMERGENCY',
  notify,
}) => {
  if (!mongoose.Types.ObjectId.isValid(String(studentRideId || ''))) {
    throw studentRideError(404, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
  }

  const ride = await StudentRide.findById(studentRideId);

  if (!ride) {
    throw studentRideError(404, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
  }

  // The booking parent raises it; a driver-side alarm would come through the
  // driver app against the dispatch ride.
  if (actor.role === 'user' && String(ride.userId) !== String(actor.id)) {
    throw studentRideError(404, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
  }

  if (!SOS_ALLOWED_STATUSES.includes(ride.status)) {
    throw studentRideError(
      409,
      STUDENT_RIDE_ERROR_CODES.INVALID_RIDE_STATUS,
      `An SOS cannot be raised while the ride is ${ride.status}.`,
    );
  }

  const lat = Number(latitude);
  const lng = Number(longitude);

  const emergency = await StudentRideEmergency.create({
    studentRideId: ride._id,
    studentId: ride.studentId,
    triggeredBy: { role: actor.role, id: actor.id },
    // Coordinates are optional: a phone that cannot get a fix must still be able
    // to raise the alarm.
    latitude: Number.isFinite(lat) && lat >= -90 && lat <= 90 ? lat : null,
    longitude: Number.isFinite(lng) && lng >= -180 && lng <= 180 ? lng : null,
    type: ['EMERGENCY', 'MEDICAL', 'ROUTE_DEVIATION', 'OTHER'].includes(type) ? type : 'EMERGENCY',
  });

  await recordEvent({
    studentRideId: ride._id,
    eventType: STUDENT_RIDE_EVENTS.SOS_TRIGGERED,
    description: 'SOS raised.',
    metadata: { type: emergency.type },
    createdBy: { role: actor.role, id: actor.id },
    session: null,
  });

  const contacts = await listEmergencyContacts(ride.studentId);

  if (notify) {
    const student = await Student.findById(ride.studentId).select('name');

    // Failure to reach a guardian must not sink the alert that is already
    // recorded; it is counted instead, so a silent failure stays visible.
    const delivered = await notify({ emergency, ride, student, contacts }).catch(() => 0);

    emergency.notifiedContacts = Number(delivered) || 0;
    await emergency.save().catch(() => null);
  }

  return serializeEmergency(emergency);
};

export const listRideEmergencies = async ({ studentRideId, userId }) => {
  const ride = await StudentRide.findById(studentRideId);

  if (!ride || String(ride.userId) !== String(userId)) {
    throw studentRideError(404, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
  }

  const rows = await StudentRideEmergency.find({ studentRideId }).sort({ createdAt: -1 });

  return rows.map(serializeEmergency);
};

/**
 * Close out an alert. The original is never edited away — a resolution is
 * recorded alongside it.
 */
export const resolveEmergency = async ({ emergencyId, userId, notes, status = 'RESOLVED' }) => {
  if (!mongoose.Types.ObjectId.isValid(String(emergencyId || ''))) {
    throw studentRideError(404, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Emergency not found.');
  }

  const emergency = await StudentRideEmergency.findById(emergencyId);

  if (!emergency) {
    throw studentRideError(404, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Emergency not found.');
  }

  const ride = await StudentRide.findById(emergency.studentRideId).select('userId');

  if (!ride || String(ride.userId) !== String(userId)) {
    throw studentRideError(404, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Emergency not found.');
  }

  emergency.status = ['ACKNOWLEDGED', 'RESOLVED', 'CANCELLED'].includes(status) ? status : 'RESOLVED';
  emergency.resolvedAt = new Date();
  emergency.resolutionNotes = String(notes || '').trim();
  await emergency.save();

  return serializeEmergency(emergency);
};
