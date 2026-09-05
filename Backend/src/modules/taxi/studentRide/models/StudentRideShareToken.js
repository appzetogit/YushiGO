import mongoose from 'mongoose';

/**
 * A revocable, expiring grant to watch one ride (§27).
 *
 * Only a hash is stored. The link goes to WhatsApp, gets forwarded, and lives in
 * other people's message history — so the value that opens it must not also be
 * sitting in the database. A leaked dump yields hashes, not working links.
 *
 * Scoped to a single ride, never to a student (§64): a token that followed a
 * child across future trips would keep granting access long after the journey
 * anyone was told about had ended.
 */
const studentRideShareTokenSchema = new mongoose.Schema(
  {
    studentRideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiStudentRide',
      required: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      required: true,
    },
    // sha256 of the token. Indexed because it is the lookup key on every public
    // request; unique so two grants can never collide.
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    lastAccessedAt: {
      type: Date,
      default: null,
    },
    accessCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

studentRideShareTokenSchema.index({ studentRideId: 1, revokedAt: 1 });

export const StudentRideShareToken =
  mongoose.models.TaxiStudentRideShareToken
  || mongoose.model('TaxiStudentRideShareToken', studentRideShareTokenSchema);
