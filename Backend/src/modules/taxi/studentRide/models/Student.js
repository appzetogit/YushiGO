import mongoose from 'mongoose';
import { STUDENT_STATUS, STUDENT_VERIFICATION_STATUS } from '../constants/index.js';

const studentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    profilePhotoUrl: {
      type: String,
      default: '',
      trim: true,
    },
    // Source of truth for age. Age is never stored — it is derived on read, so a
    // student cannot silently stay 17 forever, and a client cannot claim an age.
    dateOfBirth: {
      type: Date,
      required: true,
    },
    gender: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
    schoolName: {
      type: String,
      default: '',
      trim: true,
      maxlength: 200,
    },
    className: {
      type: String,
      default: '',
      trim: true,
      maxlength: 60,
    },
    phone: {
      type: String,
      default: '',
      trim: true,
    },
    countryCode: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(STUDENT_STATUS),
      default: STUDENT_STATUS.ACTIVE,
      index: true,
    },
    /**
     * Aadhaar. The number is encrypted (AES-GCM) and never returned; responses
     * carry only the last four digits. `lookup` is a keyed hash so the same
     * number on two records can be spotted without decrypting either.
     */
    aadhaar: {
      encrypted: { type: String, default: '', select: false },
      lookup: { type: String, default: '', select: false },
      last4: { type: String, default: '', trim: true },
      verified: { type: Boolean, default: false },
      verifiedAt: { type: Date, default: null },
      provider: { type: String, default: '', trim: true },
      // Name as the provider returned it, for the admin to compare.
      providerName: { type: String, default: '', trim: true },
      // Pending OTP session with the provider; never returned.
      referenceId: { type: String, default: '', select: false },
      initiatedAt: { type: Date, default: null },
    },
    studentIdNumber: {
      type: String,
      default: '',
      trim: true,
      maxlength: 60,
    },
    studentIdPhotoUrl: {
      type: String,
      default: '',
      trim: true,
    },
    verificationStatus: {
      type: String,
      enum: Object.values(STUDENT_VERIFICATION_STATUS),
      default: STUDENT_VERIFICATION_STATUS.PENDING,
      index: true,
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiAdmin',
      default: null,
    },
    verifiedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: '', trim: true, maxlength: 500 },
    // Soft delete only: completed rides reference this student and must keep
    // resolving after the parent removes them from the picker.
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

studentSchema.index({ userId: 1, status: 1, deletedAt: 1 });
studentSchema.index({ userId: 1, createdAt: -1 });
studentSchema.index({ verificationStatus: 1, createdAt: -1 });
studentSchema.index({ 'aadhaar.lookup': 1 }, { partialFilterExpression: { 'aadhaar.lookup': { $gt: '' } } });

export const Student = mongoose.models.TaxiStudent || mongoose.model('TaxiStudent', studentSchema);
