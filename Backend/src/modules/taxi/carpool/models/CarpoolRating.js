import mongoose from 'mongoose';

/**
 * A rating left on one carpool booking.
 *
 * Direction is stored explicitly (§36): the same trip produces a
 * passenger -> host rating and a host -> passenger rating, and the two must not
 * be averaged together. Taxi ratings on TaxiRide are single-direction and
 * embedded on the ride, which is why they could not be reused here.
 */
const carpoolRatingSchema = new mongoose.Schema(
  {
    rideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiCarpoolRide',
      required: true,
      index: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiCarpoolBooking',
      required: true,
      index: true,
    },
    raterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      required: true,
      index: true,
    },
    ratedUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      required: true,
      index: true,
    },
    // Which seat the rater occupied on this trip, not a permanent account type.
    raterRole: {
      type: String,
      enum: ['host', 'passenger'],
      required: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    review: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
  },
  { timestamps: true },
);

carpoolRatingSchema.index({ ratedUserId: 1, createdAt: -1 });

// One rating per person per booking per direction (§35): both parties may rate
// the same booking, neither may rate it twice.
carpoolRatingSchema.index({ bookingId: 1, raterId: 1 }, { unique: true });

export const CarpoolRating =
  mongoose.models.TaxiCarpoolRating || mongoose.model('TaxiCarpoolRating', carpoolRatingSchema);
