import mongoose from 'mongoose';
import { DRIVER_HIRE_TRANSMISSIONS } from '../constants/index.js';

/**
 * The customer's own car, as a hired driver needs to know it: make, model and
 * transmission. Nothing else is collected (spec §3, §5) — no registration
 * number, no documents.
 */
const customerVehicleSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiUser', required: true, index: true },
    make: { type: String, required: true, trim: true, maxlength: 60 },
    model: { type: String, required: true, trim: true, maxlength: 60 },
    transmission: { type: String, enum: Object.values(DRIVER_HIRE_TRANSMISSIONS), required: true },
    notes: { type: String, default: '', trim: true, maxlength: 300 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

customerVehicleSchema.index({ customerId: 1, deletedAt: 1 });

export const CustomerVehicle =
  mongoose.models.TaxiDriverHireVehicle || mongoose.model('TaxiDriverHireVehicle', customerVehicleSchema);
