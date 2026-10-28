import mongoose from 'mongoose';

/** Sub-documents shared by quotes and bookings. */

export const placeSchema = new mongoose.Schema(
  {
    address: { type: String, required: true, trim: true, maxlength: 300 },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
  },
  { _id: false },
);

export const fareLineSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    amount: { type: Number, required: true },
    // Reimbursements (tolls, parking) pass straight to the driver: no commission, no tax.
    passThrough: { type: Boolean, default: false },
  },
  { _id: false },
);

/**
 * A priced fare, frozen at the moment it was calculated. `terms` copies the
 * waiting, overtime and cancellation rules the customer was shown, so a later
 * pricing change can never rewrite what they agreed to.
 */
export const fareSchema = new mongoose.Schema(
  {
    pricingId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriverHirePricing', required: true },
    pricingVersion: { type: Number, required: true },
    currency: { type: String, required: true },
    lines: { type: [fareLineSchema], default: [] },
    subtotal: { type: Number, required: true },
    tax: { type: Number, default: 0 },
    total: { type: Number, required: true },
    platformFee: { type: Number, default: 0 },
    driverAmount: { type: Number, default: 0 },
    terms: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);
