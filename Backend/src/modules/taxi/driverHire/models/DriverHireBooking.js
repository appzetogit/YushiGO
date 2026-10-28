import mongoose from 'mongoose';
import {
  DRIVER_HIRE_OUTSTATION_TRIP,
  DRIVER_HIRE_PAYMENT_METHODS,
  DRIVER_HIRE_SERVICE_TYPES,
  DRIVER_HIRE_STATUS,
  DRIVER_HIRE_TRANSMISSIONS,
} from '../constants/index.js';
import { fareLineSchema, fareSchema, placeSchema } from './schemas.js';

const timelineEntrySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    // Events that are not status changes: OFFERED, OFFER_DECLINED, DRIVER_RELEASED…
    event: { type: String, default: '' },
    at: { type: Date, default: Date.now },
    actorRole: { type: String, enum: ['user', 'driver', 'admin', 'system'], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    note: { type: String, default: '', maxlength: 500 },
  },
  { _id: false },
);

// The start code the customer reads out to the driver. The customer's app shows
// it again on every open, so it is encrypted (fieldCrypto) rather than hashed,
// and never selected by default; the attempt limit stops a driver guessing it.
const otpStateSchema = new mongoose.Schema(
  {
    code: { type: String, default: '', select: false },
    issuedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
  },
  { _id: false },
);

const expenseSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['TOLL', 'PARKING', 'OTHER'], required: true },
    amount: { type: Number, required: true, min: 0 },
    note: { type: String, default: '', maxlength: 200 },
  },
  { _id: false },
);

/**
 * A Search a Driver booking. The car is the customer's (vehicle is a snapshot
 * of their saved car); the driver is a verified DriverHireProfile holder.
 *
 * Status moves only through DRIVER_HIRE_TRANSITIONS, and each move is a
 * conditional update on the current status, so two actors racing on the same
 * booking cannot both win.
 */
const driverHireBookingSchema = new mongoose.Schema(
  {
    bookingCode: { type: String, required: true, unique: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiUser', required: true, index: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver', default: null, index: true },
    quoteId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriverHireQuote', required: true, unique: true },

    serviceType: { type: String, enum: Object.values(DRIVER_HIRE_SERVICE_TYPES), required: true, index: true },
    serviceLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiServiceLocation', default: null, index: true },
    pickup: { type: placeSchema, required: true },
    destination: { type: placeSchema, default: null },
    stops: { type: [placeSchema], default: [] },
    outstationTripType: { type: String, enum: [...Object.values(DRIVER_HIRE_OUTSTATION_TRIP), null], default: null },
    scheduledAt: { type: Date, required: true },
    durationMinutes: { type: Number, required: true },
    nights: { type: Number, default: 0 },
    eventPackageCode: { type: String, default: null },
    // scheduledAt + duration: the window a driver is committed for.
    windowEndsAt: { type: Date, required: true },

    vehicle: {
      vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriverHireVehicle', required: true },
      make: { type: String, required: true },
      model: { type: String, required: true },
      transmission: { type: String, enum: Object.values(DRIVER_HIRE_TRANSMISSIONS), required: true },
      notes: { type: String, default: '' },
    },
    requirements: { type: String, default: '', trim: true, maxlength: 500 },

    fare: { type: fareSchema, required: true },
    termsAcceptedAt: { type: Date, required: true },
    paymentMethod: { type: String, enum: Object.values(DRIVER_HIRE_PAYMENT_METHODS), required: true },

    status: {
      type: String,
      enum: Object.values(DRIVER_HIRE_STATUS),
      default: DRIVER_HIRE_STATUS.REQUESTED,
      index: true,
    },
    timeline: { type: [timelineEntrySchema], default: [] },

    // A request put to one driver, who has until expiresAt to answer. With no
    // live offer, any eligible online driver may take the booking.
    offer: {
      driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver', default: null },
      offeredAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
      offeredBy: { type: String, enum: ['admin', 'system', null], default: null },
    },
    declinedDriverIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver' }], default: [] },

    assignedAt: { type: Date, default: null },
    enRouteAt: { type: Date, default: null },
    arrivedAt: { type: Date, default: null },
    customerConfirmedArrivalAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },

    startOtp: { type: otpStateSchema, default: () => ({}) },

    cancellation: {
      reason: { type: String, default: '' },
      fee: { type: Number, default: 0 },
      noShow: { type: Boolean, default: false },
      actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },

    final: {
      actualMinutes: { type: Number, default: null },
      waitingMinutes: { type: Number, default: null },
      expenses: { type: [expenseSchema], default: [] },
      lines: { type: [fareLineSchema], default: [] },
      subtotal: { type: Number, default: null },
      tax: { type: Number, default: null },
      total: { type: Number, default: null },
      platformFee: { type: Number, default: null },
      driverAmount: { type: Number, default: null },
    },

    // Kept only while a driver is on the way or driving; cleared at the end.
    driverLocation: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      at: { type: Date, default: null },
    },

    dispute: {
      openedAt: { type: Date, default: null },
      openedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
      note: { type: String, default: '' },
      resolvedAt: { type: Date, default: null },
      resolvedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
      outcome: { type: String, default: '' },
    },

    customerRated: { type: Boolean, default: false },
    driverRated: { type: Boolean, default: false },
  },
  { timestamps: true },
);

driverHireBookingSchema.index({ status: 1, scheduledAt: 1 });
driverHireBookingSchema.index({ driverId: 1, status: 1, scheduledAt: 1 });
driverHireBookingSchema.index({ customerId: 1, createdAt: -1 });
driverHireBookingSchema.index({ 'offer.driverId': 1, status: 1 });

export const DriverHireBooking =
  mongoose.models.TaxiDriverHireBooking || mongoose.model('TaxiDriverHireBooking', driverHireBookingSchema);
