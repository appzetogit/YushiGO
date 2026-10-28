import mongoose from 'mongoose';
import {
  DRIVER_HIRE_PAYMENT_KIND,
  DRIVER_HIRE_PAYMENT_METHODS,
  DRIVER_HIRE_PAYMENT_STATUS,
  DRIVER_HIRE_REFUND_STATUS,
  DRIVER_HIRE_REVIEW_STATUS,
  DRIVER_HIRE_SUPPORT_CATEGORIES,
  DRIVER_HIRE_SUPPORT_STATUS,
} from '../constants/index.js';

/**
 * The records around a booking: what was charged, what was said about it, what
 * went wrong, and who changed what. Small schemas, so they share a file.
 */

// ── Payment ─────────────────────────────────────────────────────────────────
// One row per (booking, kind). The amounts are copied from the booking's final
// fare (or cancellation fee) so payouts reconcile without recomputing anything.
const driverHirePaymentSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriverHireBooking', required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiUser', required: true, index: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver', default: null, index: true },
    kind: { type: String, enum: Object.values(DRIVER_HIRE_PAYMENT_KIND), required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    method: { type: String, enum: Object.values(DRIVER_HIRE_PAYMENT_METHODS), required: true },
    paymentStatus: {
      type: String,
      enum: Object.values(DRIVER_HIRE_PAYMENT_STATUS),
      default: DRIVER_HIRE_PAYMENT_STATUS.PENDING,
      index: true,
    },
    // Token or order id from the payment provider; card data never touches us.
    gatewayReference: { type: String, default: '' },
    paidAt: { type: Date, default: null },
    refundStatus: {
      type: String,
      enum: Object.values(DRIVER_HIRE_REFUND_STATUS),
      default: DRIVER_HIRE_REFUND_STATUS.NONE,
    },
    refundAmount: { type: Number, default: 0, min: 0 },
    refundReason: { type: String, default: '' },
    platformFee: { type: Number, default: 0 },
    driverAmount: { type: Number, default: 0 },
    payoutStatus: { type: String, enum: ['PENDING', 'PAID', 'NOT_APPLICABLE'], default: 'PENDING' },
  },
  { timestamps: true },
);

driverHirePaymentSchema.index({ bookingId: 1, kind: 1 }, { unique: true });

export const DriverHirePayment =
  mongoose.models.TaxiDriverHirePayment || mongoose.model('TaxiDriverHirePayment', driverHirePaymentSchema);

// ── Review ──────────────────────────────────────────────────────────────────
const driverHireReviewSchema = new mongoose.Schema(
  {
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriverHireBooking', required: true },
    reviewerRole: { type: String, enum: ['user', 'driver'], required: true },
    reviewerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    revieweeId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '', trim: true, maxlength: 1000 },
    moderationStatus: {
      type: String,
      enum: Object.values(DRIVER_HIRE_REVIEW_STATUS),
      default: DRIVER_HIRE_REVIEW_STATUS.PUBLISHED,
      index: true,
    },
    moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiAdmin', default: null },
  },
  { timestamps: true },
);

driverHireReviewSchema.index({ bookingId: 1, reviewerRole: 1 }, { unique: true });

export const DriverHireReview =
  mongoose.models.TaxiDriverHireReview || mongoose.model('TaxiDriverHireReview', driverHireReviewSchema);

// ── Support case ────────────────────────────────────────────────────────────
const driverHireSupportCaseSchema = new mongoose.Schema(
  {
    caseCode: { type: String, required: true, unique: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriverHireBooking', default: null, index: true },
    raisedByRole: { type: String, enum: ['user', 'driver'], required: true },
    raisedById: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    category: { type: String, enum: DRIVER_HIRE_SUPPORT_CATEGORIES, required: true },
    priority: { type: String, enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'], default: 'NORMAL', index: true },
    description: { type: String, required: true, trim: true, maxlength: 2000 },
    status: {
      type: String,
      enum: Object.values(DRIVER_HIRE_SUPPORT_STATUS),
      default: DRIVER_HIRE_SUPPORT_STATUS.OPEN,
      index: true,
    },
    resolutionNotes: { type: String, default: '', trim: true, maxlength: 2000 },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiAdmin', default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const DriverHireSupportCase =
  mongoose.models.TaxiDriverHireSupportCase || mongoose.model('TaxiDriverHireSupportCase', driverHireSupportCaseSchema);

// ── Audit log ───────────────────────────────────────────────────────────────
// Append-only. Admin decisions, pricing changes and every status change land here.
const driverHireAuditLogSchema = new mongoose.Schema(
  {
    actorRole: { type: String, enum: ['user', 'driver', 'admin', 'system'], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    action: { type: String, required: true, index: true },
    entityType: { type: String, required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    changeSummary: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

driverHireAuditLogSchema.index({ entityType: 1, createdAt: -1 });

export const DriverHireAuditLog =
  mongoose.models.TaxiDriverHireAuditLog || mongoose.model('TaxiDriverHireAuditLog', driverHireAuditLogSchema);
