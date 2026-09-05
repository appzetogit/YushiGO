import * as studentService from '../services/studentService.js';
import * as guardianService from '../services/guardianService.js';
import * as savedLocationService from '../services/savedLocationService.js';

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
