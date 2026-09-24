import { AdminBusinessSetting } from '../../admin/models/AdminBusinessSetting.js';
import { studentRideConfig } from '../constants/index.js';

/**
 * Admin-set rules for student rides (business settings, category
 * "student-ride"). Defaults apply until an admin sets them.
 *
 *   multi_child_fare_mode     'flat'      one fare however many children
 *                             'per_child' each extra child adds extra_child_fare_percent
 *   extra_child_fare_percent  100         only used for per_child
 *   max_children_per_ride     3           capped by STUDENT_RIDE_MAX_CHILDREN
 */
export const getStudentRideSettings = async () => {
  const doc = await AdminBusinessSetting.findOne({ scope: 'default' }).select('student_ride').lean();
  const raw = doc?.student_ride || {};
  const ceiling = studentRideConfig().maxChildrenPerRide;
  const max = Number(raw.max_children_per_ride);
  const percent = Number(raw.extra_child_fare_percent);

  return {
    multiChildFareMode: raw.multi_child_fare_mode === 'per_child' ? 'per_child' : 'flat',
    extraChildFarePercent: Number.isFinite(percent) && percent >= 0 ? percent : 100,
    maxChildrenPerRide: Number.isInteger(max) && max >= 1 ? Math.min(max, ceiling) : Math.min(3, ceiling),
  };
};

/** The fare for a ride carrying `children` students, from the single-rider quote. */
export const applyMultiChildFare = (quote, children, settings) => {
  if (children <= 1 || settings.multiChildFareMode !== 'per_child') {
    return { ...quote, children, multiChild: { mode: settings.multiChildFareMode, children } };
  }

  const multiplier = 1 + ((children - 1) * settings.extraChildFarePercent) / 100;
  const round = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

  return {
    ...quote,
    fare: round(quote.fare * multiplier),
    children,
    multiChild: {
      mode: 'per_child',
      children,
      extraChildFarePercent: settings.extraChildFarePercent,
      singleRiderFare: quote.fare,
    },
  };
};

const TWO_WHEELER = /\b(bike|motor ?bike|motorcycle|scooter|scooty|two[- ]?wheeler|2[- ]?wheeler)\b/i;

/**
 * Whether a vehicle type may carry a student.
 *
 * An admin's explicit allowed_for_student_ride wins. Unset, a two-wheeler is
 * refused — never a child on a bike — and everything else is allowed, so the
 * vehicle types in use today keep working until an admin says otherwise.
 */
export const vehicleAllowedForStudentRide = (vehicle) => {
  if (!vehicle) {
    return false;
  }

  if (vehicle.allowed_for_student_ride === true || vehicle.allowed_for_student_ride === false) {
    return vehicle.allowed_for_student_ride;
  }

  return ![vehicle.icon_types, vehicle.name, vehicle.category].some((value) => TWO_WHEELER.test(String(value || '')));
};
