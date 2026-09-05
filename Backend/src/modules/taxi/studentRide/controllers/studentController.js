import * as studentService from '../services/studentService.js';
import * as guardianService from '../services/guardianService.js';
import * as savedLocationService from '../services/savedLocationService.js';
import * as rideService from '../services/studentRideService.js';
import * as dispatch from '../services/dispatchAdapter.js';
import * as shareService from '../services/shareService.js';
import * as emergencyService from '../services/emergencyService.js';
import * as notifications from '../services/studentRideNotifications.js';

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
