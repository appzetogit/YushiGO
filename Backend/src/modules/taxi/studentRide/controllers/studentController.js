import * as studentService from '../services/studentService.js';
import * as guardianService from '../services/guardianService.js';
import * as savedLocationService from '../services/savedLocationService.js';
import * as rideService from '../services/studentRideService.js';
import * as dispatch from '../services/dispatchAdapter.js';

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
