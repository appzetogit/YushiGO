import mongoose from 'mongoose';
import { StudentRide } from '../models/StudentRide.js';
import { StudentRideEvent } from '../models/StudentRideEvent.js';
import { StudentRideEmergency } from '../models/StudentRideEmergency.js';
import { Student } from '../models/Student.js';
import { STUDENT_RIDE_ERROR_CODES, STUDENT_RIDE_STATUS } from '../constants/index.js';
import { studentRideError } from './studentService.js';

/**
 * Read-only operator visibility into student rides.
 *
 * The bypass flag is the most safety-relevant signal this module produces — a
 * child collected or dropped without the code being checked — and until now it
 * reached nobody but the booking parent. These endpoints exist so an operator
 * can find those rides. Nothing here writes.
 */

const MAX_LIMIT = 100;

const pageParams = (query = {}) => {
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), MAX_LIMIT);
  const page = Math.max(Number(query.page) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
};

const summarize = (ride) => ({
  studentRideId: String(ride._id),
  rideId: String(ride.rideId),
  status: ride.status,
  student: ride.studentId && typeof ride.studentId === 'object'
    ? { id: String(ride.studentId._id), name: ride.studentId.name || '' }
    : { id: String(ride.studentId) },
  userId: String(ride.userId),
  pickupAddress: ride.pickup?.address || '',
  destinationAddress: ride.destination?.address || '',
  scheduledAt: ride.scheduledAt,
  otpBypassed: {
    pickup: Boolean(ride.otpBypassed?.pickup),
    drop: Boolean(ride.otpBypassed?.drop),
  },
  pickupOtpVerified: Boolean(ride.pickupOtp?.verifiedAt),
  dropOtpVerified: Boolean(ride.dropOtp?.verifiedAt),
  startedAt: ride.startedAt,
  completedAt: ride.completedAt,
  cancelledAt: ride.cancelledAt,
  createdAt: ride.createdAt,
});

/**
 * List student rides.
 *
 * `bypassed=true` returns rides where either gate was crossed without a check —
 * the filter an operator reviewing safety will actually use.
 */
export const listStudentRidesForAdmin = async (query = {}) => {
  const filter = {};

  if (query.status) {
    const status = String(query.status).toUpperCase();

    if (!Object.values(STUDENT_RIDE_STATUS).includes(status)) {
      throw studentRideError(422, STUDENT_RIDE_ERROR_CODES.INVALID_RIDE_STATUS, `Unknown status ${status}.`);
    }

    filter.status = status;
  }

  if (String(query.bypassed) === 'true') {
    filter.$or = [{ 'otpBypassed.pickup': true }, { 'otpBypassed.drop': true }];
  }

  if (query.studentId && mongoose.Types.ObjectId.isValid(String(query.studentId))) {
    filter.studentId = query.studentId;
  }

  if (query.userId && mongoose.Types.ObjectId.isValid(String(query.userId))) {
    filter.userId = query.userId;
  }

  const { limit, page, skip } = pageParams(query);

  const [rides, total] = await Promise.all([
    StudentRide.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('studentId', 'name'),
    StudentRide.countDocuments(filter),
  ]);

  return {
    results: rides.map(summarize),
    paginator: { total, page, limit, lastPage: Math.max(1, Math.ceil(total / limit)) },
  };
};

export const getStudentRideForAdmin = async (studentRideId) => {
  if (!mongoose.Types.ObjectId.isValid(String(studentRideId || ''))) {
    throw studentRideError(404, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
  }

  const ride = await StudentRide.findById(studentRideId).populate('studentId', 'name schoolName className');

  if (!ride) {
    throw studentRideError(404, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
  }

  const [events, emergencies] = await Promise.all([
    StudentRideEvent.find({ studentRideId: ride._id }).sort({ createdAt: 1 }),
    StudentRideEmergency.find({ studentRideId: ride._id }).sort({ createdAt: -1 }),
  ]);

  return {
    ...summarize(ride),
    student: ride.studentId && typeof ride.studentId === 'object'
      ? {
        id: String(ride.studentId._id),
        name: ride.studentId.name || '',
        schoolName: ride.studentId.schoolName || '',
        className: ride.studentId.className || '',
      }
      : null,
    // The full audit trail, including bypass events with their times.
    timeline: events.map((event) => ({
      eventType: event.eventType,
      oldStatus: event.oldStatus || '',
      newStatus: event.newStatus || '',
      description: event.description || '',
      createdBy: event.createdBy?.role || 'system',
      at: event.createdAt,
    })),
    emergencies: emergencies.map((emergency) => ({
      emergencyId: String(emergency._id),
      type: emergency.type,
      status: emergency.status,
      latitude: emergency.latitude,
      longitude: emergency.longitude,
      notifiedContacts: emergency.notifiedContacts,
      triggeredBy: emergency.triggeredBy?.role || '',
      createdAt: emergency.createdAt,
      resolvedAt: emergency.resolvedAt,
      resolutionNotes: emergency.resolutionNotes || '',
    })),
  };
};

/** SOS alerts across all rides — previously readable only by the booking parent. */
export const listEmergenciesForAdmin = async (query = {}) => {
  const filter = {};

  if (query.status) {
    filter.status = String(query.status).toUpperCase();
  }

  const { limit, page, skip } = pageParams(query);

  const [rows, total] = await Promise.all([
    StudentRideEmergency.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    StudentRideEmergency.countDocuments(filter),
  ]);

  const studentIds = [...new Set(rows.map((row) => String(row.studentId)))];
  const students = await Student.find({ _id: { $in: studentIds } }).select('name');
  const nameById = new Map(students.map((student) => [String(student._id), student.name]));

  return {
    results: rows.map((row) => ({
      emergencyId: String(row._id),
      studentRideId: String(row.studentRideId),
      studentName: nameById.get(String(row.studentId)) || '',
      type: row.type,
      status: row.status,
      latitude: row.latitude,
      longitude: row.longitude,
      notifiedContacts: row.notifiedContacts,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
    })),
    paginator: { total, page, limit, lastPage: Math.max(1, Math.ceil(total / limit)) },
  };
};
