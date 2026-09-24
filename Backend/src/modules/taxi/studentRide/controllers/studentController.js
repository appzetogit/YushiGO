import * as studentService from '../services/studentService.js';
import * as guardianService from '../services/guardianService.js';
import * as savedLocationService from '../services/savedLocationService.js';
import * as rideService from '../services/studentRideService.js';
import * as dispatch from '../services/dispatchAdapter.js';
import * as shareService from '../services/shareService.js';
import * as fareService from '../services/fareService.js';
import * as adminStudentRideService from '../services/adminStudentRideService.js';
import * as emergencyService from '../services/emergencyService.js';
import * as notifications from '../services/studentRideNotifications.js';
import { applyMultiChildFare, vehicleAllowedForStudentRide } from '../services/studentRideSettings.js';
import * as aadhaarService from '../services/aadhaarService.js';
import * as adminStudentVerificationService from '../services/adminStudentVerificationService.js';

export const listStudents = async (req, res) => {
  const students = await studentService.listStudents({
    userId: req.auth.sub,
    includeInactive: String(req.query?.includeInactive || '') === 'true',
  });

  res.json({ success: true, data: { students } });
};

export const getStudent = async (req, res) => {
  const student = await studentService.getStudent({
    studentId: req.params.studentId,
    userId: req.auth.sub,
  });

  res.json({ success: true, data: { student } });
};

export const createStudent = async (req, res) => {
  const student = await studentService.createStudent({
    userId: req.auth.sub,
    payload: req.body,
  });

  res.status(201).json({ success: true, data: { student } });
};

export const updateStudent = async (req, res) => {
  const student = await studentService.updateStudent({
    studentId: req.params.studentId,
    userId: req.auth.sub,
    payload: req.body,
  });

  res.json({ success: true, data: { student } });
};

export const deactivateStudent = async (req, res) => {
  const student = await studentService.deactivateStudent({
    studentId: req.params.studentId,
    userId: req.auth.sub,
  });

  res.json({ success: true, data: { student } });
};

export const reactivateStudent = async (req, res) => {
  const student = await studentService.reactivateStudent({
    studentId: req.params.studentId,
    userId: req.auth.sub,
  });

  res.json({ success: true, data: { student } });
};

export const listGuardians = async (req, res) => {
  const guardians = await guardianService.listGuardians({
    studentId: req.params.studentId,
    userId: req.auth.sub,
  });

  res.json({ success: true, data: { guardians } });
};

export const addGuardian = async (req, res) => {
  const guardian = await guardianService.addGuardian({
    studentId: req.params.studentId,
    userId: req.auth.sub,
    payload: req.body,
  });

  res.status(201).json({ success: true, data: { guardian } });
};

export const updateGuardian = async (req, res) => {
  const guardian = await guardianService.updateGuardian({
    guardianId: req.params.guardianId,
    userId: req.auth.sub,
    payload: req.body,
  });

  res.json({ success: true, data: { guardian } });
};

export const removeGuardian = async (req, res) => {
  const result = await guardianService.removeGuardian({
    guardianId: req.params.guardianId,
    userId: req.auth.sub,
  });

  res.json({ success: true, data: result });
};

export const listSavedLocations = async (req, res) => {
  const locations = await savedLocationService.listSavedLocations({
    studentId: req.params.studentId,
    userId: req.auth.sub,
  });

  res.json({ success: true, data: { locations } });
};

export const createSavedLocation = async (req, res) => {
  const location = await savedLocationService.createSavedLocation({
    studentId: req.params.studentId,
    userId: req.auth.sub,
    payload: req.body,
  });

  res.status(201).json({ success: true, data: { location } });
};

export const getSavedLocation = async (req, res) => {
  const location = await savedLocationService.getSavedLocation({
    locationId: req.params.locationId,
    userId: req.auth.sub,
  });

  res.json({ success: true, data: { location } });
};

export const updateSavedLocation = async (req, res) => {
  const location = await savedLocationService.updateSavedLocation({
    locationId: req.params.locationId,
    userId: req.auth.sub,
    payload: req.body,
  });

  res.json({ success: true, data: { location } });
};

export const deleteSavedLocation = async (req, res) => {
  const result = await savedLocationService.deleteSavedLocation({
    locationId: req.params.locationId,
    userId: req.auth.sub,
  });

  res.json({ success: true, data: result });
};

/**
 * Price a journey without booking it, so the app can show a fare first. Uses the
 * same function the booking uses, so the quote and the charge cannot drift.
 */
export const quoteStudentRide = async (req, res) => {
  const { pickup, destination, students, settings } = await rideService.resolveRideEndpointsForQuote({
    userId: req.auth.sub,
    payload: req.body,
  });

  const single = await fareService.quoteStudentRideFare({
    vehicleTypeId: req.body?.vehicle_type_id ?? req.body?.vehicleTypeId,
    pickup,
    destination,
    serviceLocationId: req.body?.service_location_id || null,
    zoneId: req.body?.zone_id || null,
    distanceMeters: req.body?.estimated_distance_meters ?? req.body?.estimatedDistanceMeters,
  });

  const quote = applyMultiChildFare(single, students.length, settings);

  res.json({ success: true, data: quote });
};

export const createStudentRide = async (req, res) => {
  const ride = await rideService.createStudentRide({
    userId: req.auth.sub,
    payload: req.body,
    createDispatchRide: dispatch.createDispatchRide,
  });

  await dispatch.attachStudentRideToDispatch({
    rideId: ride.rideId,
    studentRideId: ride.studentRideId,
  });

  // After the link exists, so the first status sync the offer triggers can find
  // the companion. Not awaited into the response path: it never throws, and the
  // parent does not wait on driver matching to see their booking confirmed.
  dispatch.startStudentRideDispatch(ride.rideId);

  res.status(201).json({ success: true, data: ride });
};

export const listStudentRides = async (req, res) => {
  const rides = await rideService.listStudentRides({
    userId: req.auth.sub,
    studentId: req.query?.student_id || req.query?.studentId,
    status: req.query?.status,
  });

  res.json({ success: true, data: { rides } });
};

export const listUpcomingStudentRides = async (req, res) => {
  const rides = await rideService.listStudentRides({ userId: req.auth.sub, upcoming: true });
  res.json({ success: true, data: { rides } });
};

export const getStudentRide = async (req, res) => {
  const ride = await rideService.getStudentRide({
    studentRideId: req.params.studentRideId,
    userId: req.auth.sub,
  });

  res.json({ success: true, data: ride });
};

export const cancelStudentRide = async (req, res) => {
  const ride = await rideService.cancelStudentRide({
    studentRideId: req.params.studentRideId,
    userId: req.auth.sub,
    reason: req.body?.reason,
    cancelDispatchRide: dispatch.cancelDispatchRide,
  });

  res.json({ success: true, data: ride });
};

export const reissueRideOtp = async (req, res) => {
  const kind = req.params.kind === 'drop' ? 'drop' : 'pickup';

  const ride = await rideService.reissueOtp({
    studentRideId: req.params.studentRideId,
    userId: req.auth.sub,
    kind,
  });

  res.json({ success: true, data: ride });
};

/** Driver-facing: the student shows the code, the driver enters it. */
export const verifyRideOtp = async (req, res) => {
  const kind = req.params.kind === 'drop' ? 'drop' : 'pickup';

  const ride = await rideService.verifyRideOtp({
    studentRideId: req.params.studentRideId,
    kind,
    otp: req.body?.otp,
    actor: { role: 'driver', id: req.auth.sub },
    assertDriverForRide: dispatch.assertDriverForRide,
  });

  res.json({ success: true, data: ride });
};

/** Driver-facing: move the ride along the lifecycle. */
export const advanceStudentRide = async (req, res) => {
  const ride = await rideService.advanceStatus({
    studentRideId: req.params.studentRideId,
    nextStatus: String(req.body?.status || '').toUpperCase(),
    actor: { role: 'driver', id: req.auth.sub },
    expectDriverId: req.auth.sub,
    assertDriverForRide: dispatch.assertDriverForRide,
  });

  res.json({ success: true, data: ride });
};

export const createShareLink = async (req, res) => {
  const share = await shareService.createShareLink({
    studentRideId: req.params.studentRideId,
    userId: req.auth.sub,
  });

  // Sent to guardians as well as returned, so the parent does not have to
  // forward it manually for the people already on file.
  const [ride, contacts] = await Promise.all([
    rideService.getStudentRide({ studentRideId: req.params.studentRideId, userId: req.auth.sub }),
    rideService.getRideEmergencyContacts(req.params.studentRideId),
  ]);

  const notified = await notifications.sendTrackingLinkToGuardians({
    contacts,
    studentName: ride.student?.name,
    shareUrl: share.shareUrl,
  }).catch(() => 0);

  res.status(201).json({ success: true, data: { ...share, guardiansNotified: notified } });
};

export const listShareLinks = async (req, res) => {
  const shares = await shareService.listShareLinks({
    studentRideId: req.params.studentRideId,
    userId: req.auth.sub,
  });

  res.json({ success: true, data: { shares } });
};

export const revokeShareLink = async (req, res) => {
  const result = await shareService.revokeShareLink({
    studentRideId: req.params.studentRideId,
    shareId: req.params.shareId,
    userId: req.auth.sub,
  });

  res.json({ success: true, data: result });
};

/** Public — no authentication. Everything it returns is in shareService's allow-list. */
export const getPublicTracking = async (req, res) => {
  const tracking = await shareService.getPublicTracking(req.params.token);

  // Never cached: a stale copy of a child's position is worse than none, and a
  // shared link may pass through intermediaries.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({ success: true, data: tracking });
};

export const triggerSos = async (req, res) => {
  const emergency = await emergencyService.triggerSos({
    studentRideId: req.params.studentRideId,
    actor: { role: 'user', id: req.auth.sub },
    latitude: req.body?.latitude,
    longitude: req.body?.longitude,
    type: req.body?.type,
    notify: async ({ emergency: created, student, contacts }) =>
      notifications.notifyEmergencyContacts({ emergency: created, student, contacts }),
  });

  res.status(201).json({ success: true, data: emergency });
};

export const listRideEmergencies = async (req, res) => {
  const emergencies = await emergencyService.listRideEmergencies({
    studentRideId: req.params.studentRideId,
    userId: req.auth.sub,
  });

  res.json({ success: true, data: { emergencies } });
};

export const resolveEmergency = async (req, res) => {
  const emergency = await emergencyService.resolveEmergency({
    emergencyId: req.params.emergencyId,
    userId: req.auth.sub,
    notes: req.body?.notes,
    status: req.body?.status,
  });

  res.json({ success: true, data: emergency });
};

export const adminListStudentRides = async (req, res) => {
  const data = await adminStudentRideService.listStudentRidesForAdmin(req.query);
  res.json({ success: true, data });
};

export const adminGetStudentRide = async (req, res) => {
  const data = await adminStudentRideService.getStudentRideForAdmin(req.params.studentRideId);
  res.json({ success: true, data });
};

export const adminListEmergencies = async (req, res) => {
  const data = await adminStudentRideService.listEmergenciesForAdmin(req.query);
  res.json({ success: true, data });
};

// --- Identity: Aadhaar through the KYC provider -----------------------------

export const initiateAadhaar = async (req, res) => {
  const data = await aadhaarService.initiateAadhaarVerification({ userId: req.auth.sub, payload: req.body });
  res.json({ success: true, data });
};

export const verifyAadhaar = async (req, res) => {
  const student = await aadhaarService.verifyAadhaarOtp({ userId: req.auth.sub, payload: req.body });
  res.json({ success: true, data: { student } });
};

// --- Vehicles a student ride may use ----------------------------------------

/** Taxi vehicle types allowed for student rides — two-wheelers never appear. */
export const listStudentVehicleTypes = async (_req, res) => {
  const { Vehicle } = await import('../../admin/models/Vehicle.js');
  const vehicles = await Vehicle.find({ transport_type: { $in: ['taxi', 'both'] }, status: 1 })
    .select('name short_description icon_types image map_icon capacity category allowed_for_student_ride')
    .lean();

  const results = vehicles.filter(vehicleAllowedForStudentRide).map((vehicle) => ({
    vehicleTypeId: String(vehicle._id),
    name: vehicle.name,
    description: vehicle.short_description || '',
    iconType: vehicle.icon_types || '',
    icon: vehicle.map_icon || vehicle.image || '',
    capacity: vehicle.capacity || 0,
  }));

  res.json({ success: true, data: { results } });
};

// --- Carpools on the same route ----------------------------------------------

/**
 * Carpool rides along the student's route, from verified vehicles only.
 * The same corridor matching as the carpool search, including its women-only
 * rules for the parent's account.
 */
export const listCarpoolSuggestions = async (req, res) => {
  const { searchRides } = await import('../../carpool/services/carpoolRideService.js');
  const query = {
    from_lat: req.query.from_lat ?? req.query.pickup_lat,
    from_lng: req.query.from_lng ?? req.query.pickup_lng,
    to_lat: req.query.to_lat ?? req.query.drop_lat,
    to_lng: req.query.to_lng ?? req.query.drop_lng,
    date: req.query.date,
    passengers: req.query.passengers,
  };

  const rides = await searchRides({ userId: req.auth.sub, query });
  const results = rides.filter((ride) => ride.vehicle?.verified);

  res.json({ success: true, data: { results } });
};

// --- Admin: student verification --------------------------------------------

export const adminListStudents = async (req, res) => {
  const data = await adminStudentVerificationService.listStudentsForAdmin(req.query);
  res.json({ success: true, data });
};

export const adminGetStudent = async (req, res) => {
  const data = await adminStudentVerificationService.getStudentForAdmin(req.params.studentId);
  res.json({ success: true, data });
};

export const adminApproveStudent = async (req, res) => {
  const data = await adminStudentVerificationService.approveStudent({
    studentId: req.params.studentId,
    adminId: req.auth.sub,
  });
  res.json({ success: true, data });
};

export const adminRejectStudent = async (req, res) => {
  const data = await adminStudentVerificationService.rejectStudent({
    studentId: req.params.studentId,
    adminId: req.auth.sub,
    reason: req.body?.reason,
  });
  res.json({ success: true, data });
};
