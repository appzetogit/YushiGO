import mongoose from 'mongoose';
import { DRIVER_HIRE_SERVICE_TYPES } from '../constants/index.js';

/**
 * Versioned fare rules, one line per (service location, service type).
 *
 * Rules are never edited in place. A change writes a new version and moves the
 * `current` flag to it, so every quote and booking names the exact rules it was
 * priced with, and the old ones stay readable for disputes.
 *
 * serviceLocationId null is the fallback used where an area has no rules of its
 * own. Every amount is set by an admin — nothing in code is a market rate.
 */
const eventPackageSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    minutes: { type: Number, required: true, min: 30 },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const money = { type: Number, default: 0, min: 0 };

const driverHirePricingSchema = new mongoose.Schema(
  {
    serviceLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiServiceLocation', default: null },
    serviceType: { type: String, enum: Object.values(DRIVER_HIRE_SERVICE_TYPES), required: true },
    version: { type: Number, required: true, min: 1 },
    current: { type: Boolean, default: true },
    active: { type: Boolean, default: true },
    currency: { type: String, default: 'INR', trim: true, uppercase: true },

    // Time: the base fare covers includedMinutes; beyond that, blocks are charged.
    baseFare: money,
    includedMinutes: { type: Number, default: 60, min: 0 },
    minimumMinutes: { type: Number, default: 60, min: 0 },
    extraBlockMinutes: { type: Number, default: 60, min: 1 },
    extraBlockFare: money,

    // Waiting is the time between arrival and the trip starting.
    freeWaitingMinutes: { type: Number, default: 15, min: 0 },
    waitingPerMinute: money,

    // Flat charge when the pickup falls between nightStartHour and nightEndHour.
    nightCharge: money,
    nightStartHour: { type: Number, default: 22, min: 0, max: 23 },
    nightEndHour: { type: Number, default: 6, min: 0, max: 23 },

    // Outstation only.
    dailyAllowance: money,
    overnightAllowance: money,
    // A one-way trip leaves the driver away from home; this covers the way back.
    oneWayReturnFare: money,

    // Event only.
    eventPackages: { type: [eventPackageSchema], default: [] },

    bookingFee: money,
    taxPercent: { type: Number, default: 0, min: 0, max: 50 },
    platformCommissionPercent: { type: Number, default: 20, min: 0, max: 100 },

    // Cancellation and no-show, shown to the customer before they confirm.
    // Free to cancel within freeCancelMinutes of a driver being assigned, or at
    // any time while pickup is still more than freeCancelBeforePickupMinutes away.
    freeCancelMinutes: { type: Number, default: 5, min: 0 },
    freeCancelBeforePickupMinutes: { type: Number, default: 60, min: 0 },
    cancellationFee: money,
    lateCancellationFee: money,
    noShowWaitMinutes: { type: Number, default: 30, min: 5 },
    noShowFee: money,

    // Tolls and parking are the customer's (it is their car). When true, a
    // driver who paid one on the customer's behalf can add it at completion.
    allowDriverExpenses: { type: Boolean, default: true },

    notes: { type: String, default: '', trim: true, maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiAdmin', default: null },
  },
  { timestamps: true },
);

driverHirePricingSchema.index({ serviceLocationId: 1, serviceType: 1, version: 1 }, { unique: true });
driverHirePricingSchema.index(
  { serviceLocationId: 1, serviceType: 1 },
  { unique: true, partialFilterExpression: { current: true } },
);

export const DriverHirePricing =
  mongoose.models.TaxiDriverHirePricing || mongoose.model('TaxiDriverHirePricing', driverHirePricingSchema);
