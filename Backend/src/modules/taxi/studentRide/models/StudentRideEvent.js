import mongoose from 'mongoose';
import { STUDENT_RIDE_EVENTS } from '../constants/index.js';

/**
 * Append-only audit trail for one student ride (§17).
 *
 * Written in the same transaction as the status change it records, so the ride
 * and its history can never disagree about what happened. This is what the
 * app's timeline renders, and what a dispute is settled from — so nothing here
 * is ever updated or deleted.
 */
const studentRideEventSchema = new mongoose.Schema(
  {
    studentRideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiStudentRide',
      required: true,
      index: true,
    },
    eventType: {
      type: String,
      enum: Object.values(STUDENT_RIDE_EVENTS),
      required: true,
    },
    oldStatus: { type: String, default: '' },
    newStatus: { type: String, default: '' },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    // Free-form context for the timeline. Never carries an OTP, a token, or any
    // identification document.
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdBy: {
      role: { type: String, enum: ['user', 'driver', 'admin', 'system'], default: 'system' },
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

studentRideEventSchema.index({ studentRideId: 1, createdAt: 1 });

export const StudentRideEvent =
  mongoose.models.TaxiStudentRideEvent
  || mongoose.model('TaxiStudentRideEvent', studentRideEventSchema);
