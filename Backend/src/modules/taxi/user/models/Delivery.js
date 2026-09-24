import mongoose from 'mongoose';
import { RIDE_LIVE_STATUS, RIDE_STATUS } from '../../constants/index.js';
import { parseWeightKg } from '../services/parcelPolicy.js';

const deliverySchema = new mongoose.Schema(
  {
    rideId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiRide',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiUser',
      required: true,
      index: true,
    },
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiDriver',
      default: null,
    },
    vehicleTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TaxiVehicle',
      default: null,
    },
    vehicleIconType: {
      type: String,
      default: '',
      trim: true,
    },
    vehicleIconUrl: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(RIDE_STATUS),
      default: RIDE_STATUS.SEARCHING,
    },
    liveStatus: {
      type: String,
      enum: Object.values(RIDE_LIVE_STATUS),
      default: RIDE_LIVE_STATUS.SEARCHING,
    },
    pickupLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        required: true,
      },
    },
    pickupAddress: {
      type: String,
      default: '',
      trim: true,
    },
    dropLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        required: true,
      },
    },
    dropAddress: {
      type: String,
      default: '',
      trim: true,
    },
    fare: {
      type: Number,
      required: true,
      min: 0,
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'online'],
      default: 'cash',
      lowercase: true,
      trim: true,
    },
    parcel: {
      category: {
        type: String,
        default: '',
        trim: true,
      },
      // Kilograms. Was a free-text string; the setter still accepts labels such
      // as "5 kg" so older clients keep working.
      weight: {
        type: Number,
        default: null,
        min: 0,
        set: parseWeightKg,
      },
      photoUrl: {
        type: String,
        default: '',
        trim: true,
      },
      size: {
        type: String,
        enum: ['small', 'medium', 'large', 'custom', ''],
        default: '',
        lowercase: true,
        trim: true,
      },
      // Centimetres; only meaningful when size is 'custom'.
      customSize: {
        length: { type: Number, default: null, min: 0 },
        width: { type: Number, default: null, min: 0 },
        height: { type: Number, default: null, min: 0 },
      },
      description: {
        type: String,
        default: '',
        trim: true,
      },
      deliveryCategory: {
        type: String,
        default: '',
        trim: true,
      },
      goodsTypeFor: {
        type: String,
        default: '',
        trim: true,
      },
      deliveryScope: {
        type: String,
        enum: ['city', 'outstation'],
        default: 'city',
        lowercase: true,
        trim: true,
      },
      isOutstation: {
        type: Boolean,
        default: false,
      },
      senderName: {
        type: String,
        default: '',
        trim: true,
      },
      senderMobile: {
        type: String,
        default: '',
        trim: true,
      },
      receiverName: {
        type: String,
        default: '',
        trim: true,
      },
      receiverMobile: {
        type: String,
        default: '',
        trim: true,
      },
    },
    medicine: {
      pharmacyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TaxiPharmacy',
        default: null,
      },
      pharmacyName: {
        type: String,
        default: '',
        trim: true,
      },
      deliveryType: {
        type: String,
        default: 'pharmacy_to_home',
        trim: true,
        lowercase: true,
      },
      prescriptionUrls: {
        type: [String],
        default: [],
      },
      deliveryProofUrl: {
        type: String,
        default: '',
        trim: true,
      },
      instructions: {
        type: String,
        default: '',
        trim: true,
        maxlength: 500,
      },
    },
    /**
     * Parcel handover: the driver checks the parcel against its photo, then the
     * sender's pickup code, then the receiver's drop code.
     *
     * Kept outside `parcel` because syncDeliveryWithRide rewrites that whole
     * subdocument from the ride on every status change.
     *
     * Each code is stored twice: a hash to check it, and an encrypted copy so the
     * sender can open the app again and read it. Both are select:false, so a
     * populated delivery never carries them into a ride payload.
     */
    handover: {
      parcelVerified: { type: Boolean, default: false },
      parcelVerifiedAt: { type: Date, default: null },
      parcelVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'TaxiDriver', default: null },
      pickupOtp: {
        encrypted: { type: String, default: '', select: false },
        hash: { type: String, default: '', select: false },
        issuedAt: { type: Date, default: null },
        expiresAt: { type: Date, default: null },
        verifiedAt: { type: Date, default: null },
        attempts: { type: Number, default: 0, min: 0 },
      },
      dropOtp: {
        encrypted: { type: String, default: '', select: false },
        hash: { type: String, default: '', select: false },
        issuedAt: { type: Date, default: null },
        expiresAt: { type: Date, default: null },
        verifiedAt: { type: Date, default: null },
        attempts: { type: Number, default: 0, min: 0 },
      },
      pickedUpAt: { type: Date, default: null },
      deliveredAt: { type: Date, default: null },
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

export const Delivery = mongoose.models.Delivery || mongoose.model('Delivery', deliverySchema);
