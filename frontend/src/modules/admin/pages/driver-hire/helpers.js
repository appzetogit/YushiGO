/** Labels and helpers shared by the Search a Driver admin pages. */

export const unwrap = (response) => response?.data ?? response ?? {};

export const errorMessage = (error, fallback) => error?.response?.data?.message || error?.message || fallback;

export const SERVICE_TYPES = {
  NOW: 'Hire Now',
  SCHEDULED: 'Scheduled',
  HOURLY: 'Hourly',
  OUTSTATION: 'Outstation',
  EVENT: 'Event',
};

export const STATUS_LABELS = {
  REQUESTED: 'Requested',
  DRIVER_ASSIGNED: 'Driver assigned',
  DRIVER_EN_ROUTE: 'Driver en route',
  DRIVER_ARRIVED: 'Driver arrived',
  TRIP_STARTED: 'Trip started',
  TRIP_COMPLETED: 'Completed',
  CANCELLED_BY_CUSTOMER: 'Cancelled by customer',
  CANCELLED_BY_DRIVER: 'Cancelled by driver',
  CANCELLED_BY_ADMIN: 'Cancelled by admin',
  EXPIRED: 'No driver found',
  DISPUTED: 'Disputed',
};

export const formatDateTime = (value) => (value
  ? new Date(value).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '-');

export const formatDate = (value) => (value
  ? new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  : '-');

export const money = (value, currency = 'INR') => (value === null || value === undefined
  ? '-'
  : new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value));

export const formatMinutes = (minutes) => {
  if (!minutes && minutes !== 0) return '-';
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} day${minutes > 1440 ? 's' : ''}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
};

/** Ask for a required reason; null if the admin backs out. */
export const askReason = (question) => {
  const answer = window.prompt(question);
  if (answer === null) return null;
  return answer.trim() || null;
};
