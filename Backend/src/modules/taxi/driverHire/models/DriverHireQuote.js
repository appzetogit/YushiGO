import mongoose from 'mongoose';
import {
  DRIVER_HIRE_OUTSTATION_TRIP,
  DRIVER_HIRE_SERVICE_TYPES,
  DRIVER_HIRE_TRANSMISSIONS,
} from '../constants/index.js';
import { fareSchema, placeSchema } from './schemas.js';

/**
 * The "Draft" stage of a booking: trip details plus a server-calculated fare.
 *
 * A booking is created from a quote, never from a fare the app sends, and each
 * quote converts at most once (`bookingId` is set atomically), so a double tap
 * on Confirm cannot create two bookings.
 */
const driverHireQuoteSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiUser', required: true, index: true },
    serviceType: { type: String, enum: Object.values(DRIVER_HIRE_SERVICE_TYPES), required: true },
    serviceLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiServiceLocation', default: null },
    pickup: { type: placeSchema, required: true },
    destination: { type: placeSchema, default: null },
    stops: { type: [placeSchema], default: [] },
    outstationTripType: { type: String, enum: [...Object.values(DRIVER_HIRE_OUTSTATION_TRIP), null], default: null },
    scheduledAt: { type: Date, required: true },
    durationMinutes: { type: Number, required: true, min: 1 },
    nights: { type: Number, default: 0, min: 0 },
    eventPackageCode: { type: String, default: null },
    transmission: { type: String, enum: Object.values(DRIVER_HIRE_TRANSMISSIONS), default: null },
    fare: { type: fareSchema, required: true },
    expiresAt: { type: Date, required: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriverHireBooking', default: null },
  },
  { timestamps: true },
);

// A booking carries its own copy of the fare, so a quote is disposable a week
// after it lapses, converted or not.
driverHireQuoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export const DriverHireQuote =
  mongoose.models.TaxiDriverHireQuote || mongoose.model('TaxiDriverHireQuote', driverHireQuoteSchema);
