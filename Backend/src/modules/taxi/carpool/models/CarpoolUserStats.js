import mongoose from 'mongoose';

const directionSchema = new mongoose.Schema(
  {
    ratingSum: { type: Number, default: 0, min: 0 },
    ratingCount: { type: Number, default: 0, min: 0 },
    trips: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

/**
 * Running carpool reputation, kept per direction.
 *
 * Search results show a host's rating and trip count on every row, so the
 * average is maintained on write rather than aggregated over the ratings
 * collection on every search. Kept in its own collection rather than as fields
 * on the shared User document, so the carpool module owns its data and the
 * platform's user schema is untouched.
 */
const carpoolUserStatsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      required: true,
      unique: true,
    },
    asHost: { type: directionSchema, default: () => ({}) },
    asPassenger: { type: directionSchema, default: () => ({}) },
  },
  { timestamps: true },
);

export const CarpoolUserStats =
  mongoose.models.TaxiCarpoolUserStats
  || mongoose.model('TaxiCarpoolUserStats', carpoolUserStatsSchema);

/** Average to one decimal, or null when nobody has rated yet. */
export const averageOf = (direction) => {
  if (!direction?.ratingCount) {
    return null;
  }

  return Math.round((direction.ratingSum / direction.ratingCount) * 10) / 10;
};
