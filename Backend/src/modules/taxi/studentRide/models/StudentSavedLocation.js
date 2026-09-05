import mongoose from 'mongoose';
import { SAVED_LOCATION_LABELS } from '../constants/index.js';

const studentSavedLocationSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiStudent',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      required: true,
      index: true,
    },
    label: {
      type: String,
      enum: SAVED_LOCATION_LABELS,
      required: true,
    },
    customName: {
      type: String,
      default: '',
      trim: true,
      maxlength: 120,
    },
    address: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    latitude: {
      type: Number,
      required: true,
      min: -90,
      max: 90,
    },
    longitude: {
      type: Number,
      required: true,
      min: -180,
      max: 180,
    },
    // GeoJSON mirror of the pair above, so these can feed the same $near queries
    // the rest of the platform uses without a second representation being invented later.
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: undefined,
      },
    },
    placeId: {
      type: String,
      default: '',
      trim: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

studentSavedLocationSchema.index({ studentId: 1, deletedAt: 1 });
studentSavedLocationSchema.index({ studentId: 1, label: 1, deletedAt: 1 });
studentSavedLocationSchema.index({ location: '2dsphere' });

export const StudentSavedLocation =
  mongoose.models.TaxiStudentSavedLocation
  || mongoose.model('TaxiStudentSavedLocation', studentSavedLocationSchema);
