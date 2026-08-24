import mongoose from 'mongoose';

const pharmacySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      type: String,
      default: '',
      trim: true,
    },
    phone: {
      type: String,
      default: '',
      trim: true,
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: undefined,
      },
    },
    operatingHours: {
      type: String,
      default: '',
      trim: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

pharmacySchema.index({ location: '2dsphere' });
pharmacySchema.index({ active: 1, name: 1 });

export const Pharmacy = mongoose.models.TaxiPharmacy || mongoose.model('TaxiPharmacy', pharmacySchema);
