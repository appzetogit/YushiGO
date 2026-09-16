import { Ride } from '../../user/models/Ride.js';
import { STUDENT_RIDE_ERROR_CODES } from '../constants/index.js';
import { studentRideError } from './studentService.js';

/**
 * The seam between this module and the platform's ride engine.
 *
 * Student rides travel on an ordinary TaxiRide — the same arrangement parcels
 * use — so driver matching, live location, fare and cancellation are the
 * existing implementations rather than second copies. Everything the engine
 * needs is assembled here, and nothing else in the module knows about it.
 */

/**
 * Create the dispatch ride a student ride will travel on.
 *
 * Written directly rather than through createRideRecord because that function
 * starts its own dispatch flow and its own transaction; here the ride has to be
 * created inside the caller's transaction so a failure further down cannot
 * leave a dispatch ride with no student ride attached to it.
 */
export const createDispatchRide = async ({ userId, pickup, destination, scheduledAt, payload, quote, studentName = '', session }) => {
  const [ride] = await Ride.create([{
    userId,
    pickupLocation: { type: 'Point', coordinates: [pickup.longitude, pickup.latitude] },
    dropLocation: { type: 'Point', coordinates: [destination.longitude, destination.latitude] },
    pickupAddress: pickup.address,
    dropAddress: destination.address,
    // Both come from the server-side quote. A fare taken from the request body
    // would let the caller name their own price, and a null vehicle type leaves
    // dispatch with nothing to match a driver against.
    fare: quote.fare,
    estimatedDistanceMeters: quote.distanceMeters,
    estimatedDurationMinutes: Number(payload?.estimated_duration_minutes || payload?.estimatedDurationMinutes || 0),
    vehicleTypeId: quote.vehicleTypeId,
    paymentMethod: payload?.payment_method || payload?.paymentMethod || 'cash',
    serviceType: 'student',
    studentSummary: {
      displayName: String(studentName || '').trim().split(/\s+/)[0] || '',
    },
    // transport_type keys the SetPrice lookup and driver matching, and a student
    // ride is carried by an ordinary taxi — a distinct value here would find no
    // pricing rows and no eligible drivers. serviceType is what marks it as a
    // student ride.
    transport_type: payload?.transport_type || 'taxi',
    scheduledAt,
    service_location_id: payload?.service_location_id || null,
    zone_id: payload?.zone_id || null,
  }], { session });

  return ride;
};

/** Link the two documents once the student ride exists. */
export const attachStudentRideToDispatch = async ({ rideId, studentRideId, session }) => {
  await Ride.updateOne({ _id: rideId }, { $set: { studentRideId } }, { session });
};

/**
 * Confirm a driver is the one assigned to this dispatch ride.
 *
 * Checked against the live ride rather than a copy on the student ride, so a
 * reassignment is picked up immediately and one driver can never verify an OTP
 * for another driver's trip (§46).
 */
export const assertDriverForRide = async ({ rideId, driverId, session }) => {
  const query = Ride.findById(rideId).select('driverId');

  if (session) {
    query.session(session);
  }

  const ride = await query;

  if (!ride) {
    throw studentRideError(404, STUDENT_RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
  }

  if (!ride.driverId || String(ride.driverId) !== String(driverId)) {
    throw studentRideError(
      403,
      STUDENT_RIDE_ERROR_CODES.UNAUTHORIZED_DRIVER,
      'You are not assigned to this ride.',
    );
  }

  return ride;
};

/** Cancel the underlying dispatch ride when the student ride is cancelled. */
export const cancelDispatchRide = async ({ rideId, userId }) => {
  const { cancelRideByUser } = await import('../../services/dispatchService.js');
  return cancelRideByUser({ rideId, userId, reasonCode: 'changed_plans' });
};

/**
 * Whether booking dispatches immediately. On unless explicitly switched off.
 *
 * Read at call time rather than at import, so setting
 * STUDENT_RIDE_DIRECT_DISPATCH=false and restarting with --update-env takes
 * effect without a code deploy. Off means the recovery sweep alone picks the ride
 * up, exactly as before this change.
 */
export const isDirectDispatchEnabled = () =>
  String(process.env.STUDENT_RIDE_DIRECT_DISPATCH ?? 'true').toLowerCase() !== 'false';

/**
 * Offer a newly booked student ride to drivers now, rather than on the next
 * recovery sweep.
 *
 * Every other service calls startDispatchFlow at booking; student rides did not,
 * so no driver saw the offer for up to thirty seconds. Called after the booking
 * has committed and the documents are linked — dispatch emits sockets and must
 * not run against uncommitted state.
 *
 * Never throws. The booking has already succeeded, and the sweep remains the
 * backstop, so a dispatch failure here is logged rather than turned into a
 * failed 201.
 */
export const startStudentRideDispatch = async (rideId) => {
  if (!isDirectDispatchEnabled() || !rideId) {
    return false;
  }

  try {
    const ride = await Ride.findById(rideId);

    if (!ride) {
      return false;
    }

    const { startDispatchFlow } = await import('../../services/dispatchService.js');
    await startDispatchFlow(ride);
    return true;
  } catch (error) {
    console.error('[student-ride] direct dispatch failed; recovery sweep will retry', error?.message || error);
    return false;
  }
};
