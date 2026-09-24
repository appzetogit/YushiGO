import mongoose from 'mongoose';

const adminBusinessSettingSchema = new mongoose.Schema(
  {
    scope: {
      type: String,
      required: true,
      unique: true,
      default: 'default',
    },
    general: { type: mongoose.Schema.Types.Mixed, default: {} },
    customization: { type: mongoose.Schema.Types.Mixed, default: {} },
    transport_ride: { type: mongoose.Schema.Types.Mixed, default: {} },
    bid_ride: { type: mongoose.Schema.Types.Mixed, default: {} },
    user_home_settings: { type: mongoose.Schema.Types.Mixed, default: {} },
    // { multi_child_fare_mode: 'flat' | 'per_child', extra_child_fare_percent, max_children_per_ride }
    student_ride: { type: mongoose.Schema.Types.Mixed, default: {} },
    // { rate_per_km, door_to_door_max_detour_km }
    carpool: { type: mongoose.Schema.Types.Mixed, default: {} },
    subscription: { type: mongoose.Schema.Types.Mixed, default: { mode: 'commissionOnly' } },
    referral: {
      type: mongoose.Schema.Types.Mixed,
      default: {
        driver: {
          enabled: false,
          type: 'instant_referrer',
          amount: 0,
        },
        user: {
          enabled: false,
          type: 'instant_referrer',
          amount: 0,
        },
      },
    },
  },
  {
    timestamps: true,
    minimize: false, // Ensure empty objects are stored
  },
);

export const AdminBusinessSetting =
  mongoose.models.TaxiAdminBusinessSetting || mongoose.model('TaxiAdminBusinessSetting', adminBusinessSettingSchema);
