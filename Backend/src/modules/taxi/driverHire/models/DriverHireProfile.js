import mongoose from 'mongoose';
import {
  DRIVER_HIRE_PROFILE_STATUS,
  DRIVER_HIRE_SERVICE_TYPES,
  DRIVER_HIRE_TRANSMISSIONS,
} from '../constants/index.js';

/**
 * A driver's Search a Driver profile, beside their taxi Driver account.
 *
 * Kept apart from Driver so the hire-driver review, online toggle and service
 * list never interfere with taxi dispatch: a driver can be online for one and
 * offline for the other.
 *
 * The licence number is stored encrypted; only its last four characters are
 * ever returned, and only to the driver and admins. Customers see the badge.
 */
const availabilitySlotSchema = new mongoose.Schema(
  {
    // 0 = Sunday … 6 = Saturday.
    dayOfWeek: { type: Number, min: 0, max: 6, required: true },
    from: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    to: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  },
  { _id: false },
);

const driverHireProfileSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver', required: true, unique: true },
    verificationStatus: {
      type: String,
      enum: Object.values(DRIVER_HIRE_PROFILE_STATUS),
      default: DRIVER_HIRE_PROFILE_STATUS.PENDING,
      index: true,
    },
    licenceNumberEncrypted: { type: String, default: '' },
    licenceNumberLast4: { type: String, default: '', trim: true },
    licenceExpiry: { type: Date, default: null, index: true },
    licenceDocumentUrl: { type: String, default: '', trim: true },
    transmissions: {
      type: [{ type: String, enum: Object.values(DRIVER_HIRE_TRANSMISSIONS) }],
      default: [],
    },
    serviceTypes: {
      type: [{ type: String, enum: Object.values(DRIVER_HIRE_SERVICE_TYPES) }],
      default: [],
    },
    // Empty means the driver serves every area.
    serviceLocationIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TaxiServiceLocation' }], default: [] },
    experienceYears: { type: Number, min: 0, max: 60, default: 0 },
    // Empty means "whenever I am online".
    availabilitySlots: { type: [availabilitySlotSchema], default: [] },
    isOnline: { type: Boolean, default: false, index: true },
    agreementVersion: { type: String, default: '' },
    agreementAcceptedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiAdmin', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: '', trim: true, maxlength: 500 },
    // Days-before-expiry values already reminded for the current licenceExpiry.
    licenceRemindersSent: { type: [Number], default: [] },
    // Customer ratings from Search a Driver bookings only, kept apart from the
    // taxi rating on Driver.
    ratingTotal: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    ratingAverage: { type: Number, default: 0 },
    // Bumped by every assignment. Two assignments of one driver in parallel
    // both write this document, so the transactions conflict and one retries
    // and sees the other — which is what makes the busy check safe.
    assignmentSeq: { type: Number, default: 0 },
    cancellationsAfterAccept: { type: Number, default: 0 },
  },
  { timestamps: true },
);

driverHireProfileSchema.index({ verificationStatus: 1, isOnline: 1 });

export const DriverHireProfile =
  mongoose.models.TaxiDriverHireProfile || mongoose.model('TaxiDriverHireProfile', driverHireProfileSchema);
