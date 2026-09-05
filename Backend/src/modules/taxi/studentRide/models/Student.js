import mongoose from 'mongoose';
import { STUDENT_STATUS } from '../constants/index.js';

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

export const Student = mongoose.models.TaxiStudent || mongoose.model('TaxiStudent', studentSchema);
