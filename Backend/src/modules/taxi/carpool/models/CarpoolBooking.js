import mongoose from 'mongoose';
import { CARPOOL_BOOKING_STATUS, CARPOOL_PAYMENT_STATUS } from '../constants/index.js';

const carpoolPlaceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
  },
  { _id: false },
);

const carpoolBookingSchema = new mongoose.Schema(
  {
    rideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiCarpoolRide',
      required: true,
      index: true,
    },
    passengerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      required: true,
      index: true,
    },
    // Copied from the ride, never accepted from the client (§17).
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      required: true,
      index: true,
    },
    seatCount: {
      type: Number,
      required: true,
      min: 1,
    },
    pickup: { type: carpoolPlaceSchema, required: true },
    drop: { type: carpoolPlaceSchema, required: true },

    // Priced at request time and frozen. A host editing the fare later must not
    // silently change what an already-requested passenger owes.
    pricePerSeat: { type: Number, required: true, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },

    status: {
      type: String,
      enum: Object.values(CARPOOL_BOOKING_STATUS),
      default: CARPOOL_BOOKING_STATUS.PENDING,
      index: true,
    },
    paymentStatus: {
      type: String,
      enum: Object.values(CARPOOL_PAYMENT_STATUS),
      default: CARPOOL_PAYMENT_STATUS.NOT_REQUIRED,
    },

    /**
     * True while the booking is PENDING or ACCEPTED.
     *
     * Exists to carry a partial unique index: a plain equality filter is
     * supported everywhere, whereas a `$in` over statuses is not. This is what
     * makes a repeated booking request idempotent (§48) rather than a duplicate.
     */
    isActive: {
      type: Boolean,
      default: true,
    },

    // Seats are held only from acceptance. Until then a request reserves
    // nothing, which is why §21 re-checks availability at accept time.
    seatsHeld: {
      type: Number,
      default: 0,
      min: 0,
    },

    acceptedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledBy: {
      type: String,
      enum: ['passenger', 'driver', 'system', null],
      default: null,
    },
    cancellationReason: { type: String, default: '', trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

carpoolBookingSchema.index({ rideId: 1, status: 1 });
carpoolBookingSchema.index({ passengerId: 1, createdAt: -1 });
carpoolBookingSchema.index({ driverId: 1, status: 1, createdAt: -1 });

// One live booking per passenger per ride. A passenger whose request was
// rejected or cancelled may request again, because those bookings are no longer
// active.
carpoolBookingSchema.index(
  { rideId: 1, passengerId: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

export const CarpoolBooking =
  mongoose.models.TaxiCarpoolBooking || mongoose.model('TaxiCarpoolBooking', carpoolBookingSchema);
