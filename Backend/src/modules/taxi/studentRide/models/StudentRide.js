import mongoose from 'mongoose';
import { STUDENT_RIDE_STATUS } from '../constants/index.js';

/**
 * Immutable copy of a place as it was when the ride was booked (§63).
 *
 * Saved locations are reusable templates and change over time; a ride must keep
 * showing the address the student was actually collected from, so this is
 * snapshotted at creation and never re-resolved.
 */
const snapshotSchema = new mongoose.Schema(
  {
    savedLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiStudentSavedLocation', default: null },
    label: { type: String, default: '', trim: true },
    address: { type: String, required: true, trim: true },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    placeId: { type: String, default: '', trim: true },
  },
  { _id: false },
);

/**
 * One-time code, stored only as a hash.
 *
 * The plaintext is returned once at issue and never again — not in ride detail,
 * not in logs. Verification compares hashes, so a database dump does not hand
 * over the codes needed to collect a child.
 */
const otpSchema = new mongoose.Schema(
  {
    hash: { type: String, default: '', select: false },
    expiresAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    issuedAt: { type: Date, default: null },
  },
  { _id: false },
);

const studentRideSchema = new mongoose.Schema(
  {
    // The booking account. Every read is scoped by this.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiStudent',
      required: true,
      index: true,
    },
    /**
     * The dispatch ride this student ride travels on.
     *
     * Driver matching, vehicle assignment, live location, cancellation and fare
     * all stay on TaxiRide — the same arrangement Delivery uses for parcels.
     * This document holds only what is specific to carrying a student.
     */
    rideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiRide',
      required: true,
      index: true,
    },

    pickup: { type: snapshotSchema, required: true },
    destination: { type: snapshotSchema, required: true },

    scheduledAt: { type: Date, default: null, index: true },

    status: {
      type: String,
      enum: Object.values(STUDENT_RIDE_STATUS),
      default: STUDENT_RIDE_STATUS.BOOKED,
      index: true,
    },

    pickupOtp: { type: otpSchema, default: () => ({}) },
    dropOtp: { type: otpSchema, default: () => ({}) },

    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, enum: ['user', 'driver', 'admin', 'system', null], default: null },
    cancellationReason: { type: String, default: '', trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

studentRideSchema.index({ userId: 1, status: 1, createdAt: -1 });
studentRideSchema.index({ studentId: 1, createdAt: -1 });
studentRideSchema.index({ status: 1, scheduledAt: 1 });

export const StudentRide =
  mongoose.models.TaxiStudentRide || mongoose.model('TaxiStudentRide', studentRideSchema);
