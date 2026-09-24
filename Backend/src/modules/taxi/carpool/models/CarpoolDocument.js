import mongoose from 'mongoose';

/**
 * A carpool host's verification document.
 *
 * Driver photo and driving licence belong to the host; RC and insurance belong
 * to a vehicle (vehicleId set). One row per upload: a re-upload supersedes the
 * previous row (isCurrent false) instead of overwriting it, so the review
 * history survives.
 *
 * Only ever returned to the host who owns it and to admins.
 */
export const CARPOOL_DOCUMENT_KINDS = Object.freeze({
  DRIVER_PHOTO: 'driverPhoto',
  DRIVING_LICENSE: 'drivingLicense',
  RC: 'rc',
  INSURANCE: 'insurance',
});

export const HOST_DOCUMENT_KINDS = Object.freeze([CARPOOL_DOCUMENT_KINDS.DRIVER_PHOTO, CARPOOL_DOCUMENT_KINDS.DRIVING_LICENSE]);
export const VEHICLE_DOCUMENT_KINDS = Object.freeze([CARPOOL_DOCUMENT_KINDS.RC, CARPOOL_DOCUMENT_KINDS.INSURANCE]);

/** Documents that stop being valid on a date, and so must carry one. */
export const EXPIRING_DOCUMENT_KINDS = Object.freeze([CARPOOL_DOCUMENT_KINDS.DRIVING_LICENSE, CARPOOL_DOCUMENT_KINDS.INSURANCE]);

export const CARPOOL_DOCUMENT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

const carpoolDocumentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiUser', required: true, index: true },
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiCarpoolVehicle', default: null, index: true },
    kind: { type: String, enum: Object.values(CARPOOL_DOCUMENT_KINDS), required: true },
    url: { type: String, required: true, trim: true },
    documentNumber: { type: String, default: '', trim: true, maxlength: 40 },
    expiryDate: { type: Date, default: null },
    status: {
      type: String,
      enum: Object.values(CARPOOL_DOCUMENT_STATUS),
      default: CARPOOL_DOCUMENT_STATUS.PENDING,
      index: true,
    },
    rejectionReason: { type: String, default: '', trim: true, maxlength: 500 },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiAdmin', default: null },
    reviewedAt: { type: Date, default: null },
    isCurrent: { type: Boolean, default: true },
  },
  { timestamps: true },
);

carpoolDocumentSchema.index({ userId: 1, vehicleId: 1, kind: 1, isCurrent: 1 });
carpoolDocumentSchema.index({ status: 1, isCurrent: 1, createdAt: 1 });

export const CarpoolDocument =
  mongoose.models.TaxiCarpoolDocument || mongoose.model('TaxiCarpoolDocument', carpoolDocumentSchema);
