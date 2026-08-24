import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import {
  createMedicineOrder,
  getMedicineOrder,
  getMyActiveMedicineOrder,
  listMyMedicineOrders,
  listPharmacies,
} from '../controllers/medicineController.js';

export const medicineRouter = Router();

medicineRouter.get('/pharmacies', authenticate(['user']), asyncHandler(listPharmacies));
medicineRouter.post('/', authenticate(['user']), asyncHandler(createMedicineOrder));
medicineRouter.get('/', authenticate(['user']), asyncHandler(listMyMedicineOrders));
medicineRouter.get('/active/me', authenticate(['user', 'driver']), asyncHandler(getMyActiveMedicineOrder));
medicineRouter.get('/:medicineOrderId', authenticate(['user', 'driver']), asyncHandler(getMedicineOrder));
