import mongoose from 'mongoose';
import {
  GUARDIAN_RELATIONSHIPS,
  GUARDIAN_STATUS,
  GUARDIAN_VERIFICATION_STATUS,
} from '../constants/index.js';

const studentGuardianSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiStudent',
      required: true,
      index: true,
    },
    // Denormalised from the student so ownership can be enforced in one query
    // rather than a lookup on every guardian read.
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
    relationship: {
      type: String,
      enum: GUARDIAN_RELATIONSHIPS,
      required: true,
    },
    mobile: {
      type: String,
      required: true,
      trim: true,
    },
    countryCode: {
      type: String,
      default: '',
      trim: true,
    },
    email: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
    // Identification is never returned by any public tracking response. `select:
    // false` keeps it out of query results unless a caller asks for it explicitly,
    // so it cannot leak through a spread of the document.
    idType: {
      type: String,
      default: '',
      trim: true,
      select: false,
    },
    idReference: {
      type: String,
      default: '',
      trim: true,
      select: false,
    },
    verificationStatus: {
      type: String,
      enum: Object.values(GUARDIAN_VERIFICATION_STATUS),
      default: GUARDIAN_VERIFICATION_STATUS.UNVERIFIED,
    },
    isPrimary: {
      type: Boolean,
      default: false,
    },
    isEmergencyContact: {
      type: Boolean,
      default: true,
    },
    status: {
      type: String,
      enum: Object.values(GUARDIAN_STATUS),
      default: GUARDIAN_STATUS.ACTIVE,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

studentGuardianSchema.index({ studentId: 1, status: 1, deletedAt: 1 });
studentGuardianSchema.index({ studentId: 1, isEmergencyContact: 1, status: 1 });

export const StudentGuardian =
  mongoose.models.TaxiStudentGuardian || mongoose.model('TaxiStudentGuardian', studentGuardianSchema);
