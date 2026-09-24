import { Router } from 'express';
import { asyncHandler } from '../../../../utils/asyncHandler.js';
import { authenticate } from '../../middlewares/authMiddleware.js';
import {
  createDelivery,
  getDelivery,
  getDeliveryQuote,
  getMyActiveDelivery,
  listMyDeliveries,
  uploadParcelPhoto,
  markParcelVerified,
  verifyPickupOtp,
  verifyDropOtp,
  reissueParcelOtp,
  cancelDelivery,
} from '../controllers/deliveryController.js';
import { otpSendRateLimit, otpVerifyRateLimit } from '../../middlewares/rateLimitMiddleware.js';

export const deliveryRouter = Router();

deliveryRouter.post('/quote', authenticate(['user']), asyncHandler(getDeliveryQuote));
deliveryRouter.post('/', authenticate(['user']), asyncHandler(createDelivery));
deliveryRouter.get('/', authenticate(['user']), asyncHandler(listMyDeliveries));
deliveryRouter.get('/active/me', authenticate(['user', 'driver']), asyncHandler(getMyActiveDelivery));
// Declared before /:deliveryId so the literal path is not read as an id.
deliveryRouter.post('/upload-photo', authenticate(['user']), asyncHandler(uploadParcelPhoto));
deliveryRouter.get('/:deliveryId', authenticate(['user', 'driver']), asyncHandler(getDelivery));

// Parcel handover — driver side. The driver never receives a code.
deliveryRouter.post('/:deliveryId/parcel-verified', authenticate(['driver']), asyncHandler(markParcelVerified));
deliveryRouter.post('/:deliveryId/verify-pickup-otp', otpVerifyRateLimit, authenticate(['driver']), asyncHandler(verifyPickupOtp));
deliveryRouter.post('/:deliveryId/verify-drop-otp', otpVerifyRateLimit, authenticate(['driver']), asyncHandler(verifyDropOtp));

// Sender side.
deliveryRouter.post('/:deliveryId/otp/:kind/reissue', otpSendRateLimit, authenticate(['user']), asyncHandler(reissueParcelOtp));
deliveryRouter.post('/:deliveryId/cancel', authenticate(['user']), asyncHandler(cancelDelivery));
