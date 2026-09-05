import mongoose from 'mongoose';
import { CARPOOL_VEHICLE_VERIFICATION } from '../constants/index.js';

/**
 * A user's own car.
 *
 * This is deliberately not TaxiVehicle, which is a category catalogue ("Bike",
 * "Auto Lite") with capacity and pricing, nor the vehicle fields inlined on the
 * Driver document — a carpool host is an ordinary user, not an onboarded driver.
 */
const carpoolVehicleSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      required: true,
      index: true,
    },
    make: {
      type: String,
      default: '',
      trim: true,
      maxlength: 60,
    },
    model: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },
    color: {
      type: String,
      default: '',
      trim: true,
      maxlength: 40,
    },
    vehicleType: {
      type: String,
      default: 'car',
      trim: true,
      lowercase: true,
    },
    registrationNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 20,
    },
    // Total passenger seats excluding the host. Seats offered on a ride are
    // validated against this.
    seatCapacity: {
      type: Number,
      required: true,
      min: 1,
      max: 20,
    },
    hasAc: {
      type: Boolean,
      default: true,
    },
    photoUrl: {
      type: String,
      default: '',
      trim: true,
    },
    verificationStatus: {
      type: String,
      enum: Object.values(CARPOOL_VEHICLE_VERIFICATION),
      default: CARPOOL_VEHICLE_VERIFICATION.UNVERIFIED,
    },
    // Document references are never returned by any carpool response — §42.
    // `select: false` keeps them out of a document spread by default.
    documents: {
      type: [
        {
          kind: { type: String, default: '', trim: true },
          url: { type: String, default: '', trim: true },
          uploadedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
      select: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

carpoolVehicleSchema.index({ userId: 1, deletedAt: 1 });
// One live registration per user; the same plate may legitimately reappear after
// a soft delete, so deletedAt participates in the key.
carpoolVehicleSchema.index(
  { userId: 1, registrationNumber: 1, deletedAt: 1 },
  { unique: true },
);

export const CarpoolVehicle =
  mongoose.models.TaxiCarpoolVehicle || mongoose.model('TaxiCarpoolVehicle', carpoolVehicleSchema);
