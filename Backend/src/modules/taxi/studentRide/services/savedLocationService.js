import mongoose from 'mongoose';
import { StudentSavedLocation } from '../models/StudentSavedLocation.js';
import { SAVED_LOCATION_LABELS, STUDENT_RIDE_ERRORS } from '../constants/index.js';
import { requireOwnedStudent, studentRideError } from './studentService.js';

export const serializeSavedLocation = (location) => ({
  id: String(location._id),
  studentId: String(location.studentId),
  label: location.label,
  customName: location.customName || '',
  address: location.address,
  latitude: location.latitude,
  longitude: location.longitude,
  placeId: location.placeId || '',
  createdAt: location.createdAt,
  updatedAt: location.updatedAt,
});

const parseCoordinate = (value, { field, min, max }) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw studentRideError(
      422,
      STUDENT_RIDE_ERRORS.INVALID_LOCATION,
      `${field} must be a number between ${min} and ${max}.`,
    );
  }

  return parsed;
};

const normalizeLocationInput = (payload = {}, { partial = false } = {}) => {
  const result = {};

  const label = payload.label === undefined ? undefined : String(payload.label || '').trim().toUpperCase();

  if (label !== undefined) {
    if (!SAVED_LOCATION_LABELS.includes(label)) {
      throw studentRideError(
        422,
        STUDENT_RIDE_ERRORS.INVALID_LOCATION,
        `label must be one of: ${SAVED_LOCATION_LABELS.join(', ')}.`,
      );
    }

    result.label = label;
  } else if (!partial) {
    throw studentRideError(422, STUDENT_RIDE_ERRORS.INVALID_LOCATION, 'label is required.');
  }

  const address = payload.address === undefined ? undefined : String(payload.address || '').trim();

  if (address !== undefined) {
    if (!address) {
      throw studentRideError(422, STUDENT_RIDE_ERRORS.INVALID_LOCATION, 'address cannot be empty.');
    }

    result.address = address;
  } else if (!partial) {
    throw studentRideError(422, STUDENT_RIDE_ERRORS.INVALID_LOCATION, 'address is required.');
  }

  const hasLatitude = payload.latitude !== undefined;
  const hasLongitude = payload.longitude !== undefined;

  // Coordinates move as a pair — updating one alone would leave the record
  // describing a point that was never submitted.
  if (hasLatitude !== hasLongitude) {
    throw studentRideError(
      422,
      STUDENT_RIDE_ERRORS.INVALID_LOCATION,
      'latitude and longitude must be provided together.',
    );
  }

  if (hasLatitude && hasLongitude) {
    result.latitude = parseCoordinate(payload.latitude, { field: 'latitude', min: -90, max: 90 });
    result.longitude = parseCoordinate(payload.longitude, { field: 'longitude', min: -180, max: 180 });
    result.location = { type: 'Point', coordinates: [result.longitude, result.latitude] };
  } else if (!partial) {
    throw studentRideError(422, STUDENT_RIDE_ERRORS.INVALID_LOCATION, 'latitude and longitude are required.');
  }

  for (const [field, alias] of [['customName', 'custom_name'], ['placeId', 'place_id']]) {
    const value = payload[field] ?? payload[alias];

    if (value !== undefined) {
      result[field] = String(value || '').trim();
    }
  }

  return result;
};

/**
 * Resolve a saved location the caller owns, for a specific student.
 *
 * Both halves are checked: the location must exist and belong to that student,
 * and the student must belong to the caller. Checking only the location id would
 * let one student's address be attached to another student's ride.
 */
export const requireOwnedSavedLocation = async (
  { locationId, studentId, userId },
  { session = null } = {},
) => {
  if (!mongoose.Types.ObjectId.isValid(String(locationId || ''))) {
    throw studentRideError(404, STUDENT_RIDE_ERRORS.LOCATION_NOT_FOUND, 'Saved location not found.');
  }

  const query = StudentSavedLocation.findOne({ _id: locationId, deletedAt: null });

  if (session) {
    query.session(session);
  }

  const location = await query;

  if (!location || String(location.userId) !== String(userId)) {
    throw studentRideError(404, STUDENT_RIDE_ERRORS.LOCATION_NOT_FOUND, 'Saved location not found.');
  }

  if (studentId && String(location.studentId) !== String(studentId)) {
    throw studentRideError(404, STUDENT_RIDE_ERRORS.LOCATION_NOT_FOUND, 'Saved location not found.');
  }

  return location;
};

export const listSavedLocations = async ({ studentId, userId }) => {
  await requireOwnedStudent({ studentId, userId }, { allowInactive: true });

  const locations = await StudentSavedLocation.find({ studentId, deletedAt: null })
    .sort({ label: 1, createdAt: 1 });

  return locations.map(serializeSavedLocation);
};

export const getSavedLocation = async ({ locationId, userId }) => {
  const location = await requireOwnedSavedLocation({ locationId, userId });
  return serializeSavedLocation(location);
};

export const createSavedLocation = async ({ studentId, userId, payload }) => {
  const student = await requireOwnedStudent({ studentId, userId }, { allowInactive: true });
  const input = normalizeLocationInput(payload);

  const location = await StudentSavedLocation.create({
    ...input,
    studentId: student._id,
    userId,
  });

  return serializeSavedLocation(location);
};

export const updateSavedLocation = async ({ locationId, userId, payload }) => {
  const location = await requireOwnedSavedLocation({ locationId, userId });
  const input = normalizeLocationInput(payload, { partial: true });

  Object.assign(location, input);
  await location.save();

  return serializeSavedLocation(location);
};

/**
 * Soft delete. Rides snapshot their pickup and destination at creation, so a
 * removed location never rewrites history — but keeping the row makes the
 * audit trail behind an old ride resolvable.
 */
export const deleteSavedLocation = async ({ locationId, userId }) => {
  const location = await requireOwnedSavedLocation({ locationId, userId });

  location.deletedAt = new Date();
  await location.save();

  return { id: String(location._id), deleted: true };
};
