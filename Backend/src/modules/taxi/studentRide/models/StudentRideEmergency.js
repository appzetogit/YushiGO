import mongoose from 'mongoose';

/**
 * An SOS raised during a student ride (§38).
 *
 * Kept forever, including after resolution: these records are the evidence in
 * any subsequent complaint or investigation, so nothing here is soft-deleted or
 * overwritten — a resolution is added alongside the original alert.
 */
const studentRideEmergencySchema = new mongoose.Schema(
  {
    studentRideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiStudentRide',
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiStudent',
      required: true,
      index: true,
    },
    triggeredBy: {
      role: { type: String, enum: ['user', 'driver', 'admin', 'system'], required: true },
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    // Where the alert was raised from, captured at the moment it was raised
    // rather than read back later from a moving vehicle.
    latitude: { type: Number, default: null, min: -90, max: 90 },
    longitude: { type: Number, default: null, min: -180, max: 180 },
    type: {
      type: String,
      enum: ['EMERGENCY', 'MEDICAL', 'ROUTE_DEVIATION', 'OTHER'],
      default: 'EMERGENCY',
    },
    status: {
      type: String,
      enum: ['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'CANCELLED'],
      default: 'ACTIVE',
      index: true,
    },
    // How many guardians were reached, so a failure to notify is visible after
    // the fact rather than silent.
    notifiedContacts: {
      type: Number,
      default: 0,
      min: 0,
    },
    resolvedAt: { type: Date, default: null },
    resolutionNotes: { type: String, default: '', trim: true, maxlength: 1000 },
  },
  { timestamps: true },
);

studentRideEmergencySchema.index({ status: 1, createdAt: -1 });

export const StudentRideEmergency =
  mongoose.models.TaxiStudentRideEmergency
  || mongoose.model('TaxiStudentRideEmergency', studentRideEmergencySchema);
