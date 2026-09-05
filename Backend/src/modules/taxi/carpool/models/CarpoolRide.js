import mongoose from 'mongoose';
import { CARPOOL_RIDE_STATUS } from '../constants/index.js';

const carpoolStopSchema = new mongoose.Schema(
  {
    stopOrder: { type: Number, required: true, min: 0 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
    estimatedTime: { type: String, default: '', trim: true },
  },
  { _id: true },
);

const carpoolPlaceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },
  },
  { _id: false },
);

const carpoolRideSchema = new mongoose.Schema(
  {
    // The host. Named driverId to match the spec's vocabulary, but this is an
    // ordinary TaxiUser — the same account can host one ride and ride as a
    // passenger on another.
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      required: true,
      index: true,
    },
    vehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiCarpoolVehicle',
      required: true,
    },
    origin: { type: carpoolPlaceSchema, required: true },
    destination: { type: carpoolPlaceSchema, required: true },
    pickup: { type: carpoolPlaceSchema, required: true },
    drop: { type: carpoolPlaceSchema, required: true },
    stops: { type: [carpoolStopSchema], default: [] },

    /**
     * Origin → stops → destination as a GeoJSON LineString.
     *
     * Indexed 2dsphere so a passenger's pickup can be matched against the whole
     * corridor rather than only against named endpoints: a pickup partway along
     * the route matches without being close to any stop. §14.
     */
    routePath: {
      type: {
        type: String,
        enum: ['LineString'],
        default: 'LineString',
      },
      coordinates: {
        type: [[Number]],
        default: undefined,
      },
    },

    // Departure is stored as a single UTC instant. `date` and `departureTime`
    // are kept as the host entered them, for display and for date-only filters.
    departureAt: { type: Date, required: true, index: true },
    date: { type: String, required: true, trim: true },
    departureTime: { type: String, required: true, trim: true },
    estimatedArrivalTime: { type: String, default: '', trim: true },

    // offeredSeats never changes once booked against; availableSeats is derived
    // from it and bookedSeats, which is the single source of truth for capacity.
    offeredSeats: { type: Number, required: true, min: 1 },
    bookedSeats: { type: Number, default: 0, min: 0 },
    pricePerSeat: { type: Number, required: true, min: 0 },

    preferences: {
      ac: { type: Boolean, default: false },
      smokingAllowed: { type: Boolean, default: false },
      petsAllowed: { type: Boolean, default: false },
      musicAllowed: { type: Boolean, default: true },
      luggageAllowed: { type: Boolean, default: true },
      pickupFlexibilityMinutes: { type: Number, default: 0, min: 0 },
    },

    notes: { type: String, default: '', trim: true, maxlength: 500 },

    status: {
      type: String,
      enum: Object.values(CARPOOL_RIDE_STATUS),
      default: CARPOOL_RIDE_STATUS.PUBLISHED,
      index: true,
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, default: '', trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

carpoolRideSchema.virtual('availableSeats').get(function availableSeats() {
  return Math.max(0, this.offeredSeats - this.bookedSeats);
});

carpoolRideSchema.index({ status: 1, departureAt: 1 });
carpoolRideSchema.index({ driverId: 1, status: 1, departureAt: -1 });
carpoolRideSchema.index({ routePath: '2dsphere' });

export const CarpoolRide =
  mongoose.models.TaxiCarpoolRide || mongoose.model('TaxiCarpoolRide', carpoolRideSchema);
