/**
 * The `student` block on driver-facing ride payloads.
 *
 * Deliberately importing nothing and querying nothing. It is spread into the
 * ride-request offer, the realtime ride payload and the scheduled-rides list —
 * the offer being the highest-volume payload in the system, built inside the
 * dispatch loop. Everything it needs is denormalised onto the dispatch ride at
 * booking and on OTP verification, so building it is a field read.
 *
 * For every other service type it returns an empty object, so spreading it adds
 * no key at all: a parcel or normal offer is byte-identical to before, which a
 * `student: null` would not have been.
 */
export const studentDriverBlock = (ride) => {
  if (ride?.serviceType !== 'student' || !ride.studentRideId) {
    return {};
  }

  return {
    student: {
      studentRideId: String(ride.studentRideId),
      // First name only: the driver needs to call out to the right child at the
      // gate, not to hold their full name.
      studentName: ride.studentSummary?.displayName || '',
      requiresPickupOtp: true,
      requiresDropOtp: true,
      pickupOtpVerified: Boolean(ride.studentSummary?.pickupOtpVerified),
      dropOtpVerified: Boolean(ride.studentSummary?.dropOtpVerified),
    },
  };
};
