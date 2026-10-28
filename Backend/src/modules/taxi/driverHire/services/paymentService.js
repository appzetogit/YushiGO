import {
  DRIVER_HIRE_ERRORS,
  DRIVER_HIRE_PAYMENT_KIND,
  DRIVER_HIRE_PAYMENT_METHODS,
  DRIVER_HIRE_PAYMENT_STATUS,
  DRIVER_HIRE_REFUND_STATUS,
} from '../constants/index.js';
import { DriverHirePayment } from '../models/DriverHireRecords.js';
import { audit, driverHireError, isObjectId, roundMoney } from './common.js';

/**
 * Payment records for Search a Driver (spec §5, §7).
 *
 * This is the ledger, not the gateway: one row per charge, with the platform
 * fee and driver share split out so payouts reconcile. Online collection is
 * the seam where the existing Razorpay/PhonePe integration attaches — until it
 * does, ONLINE rows wait as PENDING and an admin records the outcome.
 */

export const recordTripPayment = async ({ booking, cashCollected = false, session = null }) => {
  const final = booking.final;
  const isCash = booking.paymentMethod === DRIVER_HIRE_PAYMENT_METHODS.CASH;
  const paid = isCash && cashCollected;

  const [payment] = await DriverHirePayment.create([{
    bookingId: booking._id,
    customerId: booking.customerId,
    driverId: booking.driverId,
    kind: DRIVER_HIRE_PAYMENT_KIND.TRIP,
    amount: final.total,
    currency: booking.fare.currency,
    method: booking.paymentMethod,
    paymentStatus: final.total > 0
      ? (paid ? DRIVER_HIRE_PAYMENT_STATUS.PAID : DRIVER_HIRE_PAYMENT_STATUS.PENDING)
      : DRIVER_HIRE_PAYMENT_STATUS.NOT_REQUIRED,
    paidAt: paid ? new Date() : null,
    platformFee: final.platformFee,
    driverAmount: final.driverAmount,
    // Cash is already in the driver's hand; what is owed runs the other way.
    payoutStatus: isCash ? 'NOT_APPLICABLE' : 'PENDING',
  }], session ? { session } : {});

  return payment;
};

/**
 * A cancellation or no-show fee. The driver's share is the fee less the same
 * commission as a trip, since it compensates their time.
 */
export const recordCancellationFee = async ({ booking, fee, session = null }) => {
  if (!(fee > 0)) return null;
  const commission = roundMoney((fee * (booking.fare?.terms?.platformCommissionPercent || 0)) / 100);

  const [payment] = await DriverHirePayment.create([{
    bookingId: booking._id,
    customerId: booking.customerId,
    driverId: booking.driverId,
    kind: DRIVER_HIRE_PAYMENT_KIND.CANCELLATION_FEE,
    amount: fee,
    currency: booking.fare.currency,
    method: booking.paymentMethod,
    paymentStatus: DRIVER_HIRE_PAYMENT_STATUS.PENDING,
    platformFee: booking.driverId ? commission : fee,
    driverAmount: booking.driverId ? roundMoney(fee - commission) : 0,
    payoutStatus: booking.driverId ? 'PENDING' : 'NOT_APPLICABLE',
  }], session ? { session } : {});

  return payment;
};

export const serializePayment = (payment) => ({
  id: String(payment._id),
  bookingId: String(payment.bookingId),
  kind: payment.kind,
  amount: payment.amount,
  currency: payment.currency,
  method: payment.method,
  paymentStatus: payment.paymentStatus,
  paidAt: payment.paidAt,
  refundStatus: payment.refundStatus,
  refundAmount: payment.refundAmount,
  platformFee: payment.platformFee,
  driverAmount: payment.driverAmount,
  payoutStatus: payment.payoutStatus,
  createdAt: payment.createdAt,
});

export const listPaymentsForBooking = async (bookingId) => {
  const payments = await DriverHirePayment.find({ bookingId }).sort({ createdAt: 1 }).lean();
  return payments.map(serializePayment);
};

const requirePayment = async (paymentId) => {
  if (!isObjectId(paymentId)) throw driverHireError(404, DRIVER_HIRE_ERRORS.BOOKING_NOT_FOUND, 'Payment not found.');
  const payment = await DriverHirePayment.findById(paymentId);
  if (!payment) throw driverHireError(404, DRIVER_HIRE_ERRORS.BOOKING_NOT_FOUND, 'Payment not found.');
  return payment;
};

/** Admin: record that a pending payment was collected (or failed). */
export const adminSetPaymentStatus = async ({ adminId, paymentId, status, gatewayReference = '' }) => {
  const allowed = [DRIVER_HIRE_PAYMENT_STATUS.PAID, DRIVER_HIRE_PAYMENT_STATUS.FAILED];
  if (!allowed.includes(status)) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_PAYMENT_METHOD, 'status must be PAID or FAILED.');
  }
  const payment = await requirePayment(paymentId);
  const from = payment.paymentStatus;
  if (from === DRIVER_HIRE_PAYMENT_STATUS.PAID) {
    throw driverHireError(409, DRIVER_HIRE_ERRORS.INVALID_TRANSITION, 'This payment is already marked paid.');
  }
  payment.paymentStatus = status;
  payment.paidAt = status === DRIVER_HIRE_PAYMENT_STATUS.PAID ? new Date() : null;
  if (gatewayReference) payment.gatewayReference = String(gatewayReference).slice(0, 120);
  await payment.save();
  await audit({ actorRole: 'admin', actorId: adminId, action: 'PAYMENT_STATUS_SET', entityType: 'DriverHirePayment', entityId: payment._id, changeSummary: { from, to: status, gatewayReference } });
  return serializePayment(payment);
};

/** Record a refund decision against a payment. Never more than was paid. */
export const recordRefund = async ({ adminId, paymentId, amount, reason, completed = false, session = null }) => {
  const payment = typeof paymentId === 'object' ? paymentId : await requirePayment(paymentId);
  const refund = roundMoney(amount);
  if (!(refund > 0) || refund + (payment.refundAmount || 0) > payment.amount) {
    throw driverHireError(422, DRIVER_HIRE_ERRORS.INVALID_REFUND, `Refund must be more than 0 and at most ${roundMoney(payment.amount - (payment.refundAmount || 0))}.`);
  }
  const note = String(reason || '').trim();
  if (!note) throw driverHireError(422, DRIVER_HIRE_ERRORS.REASON_REQUIRED, 'A refund reason is required.');

  payment.refundAmount = roundMoney((payment.refundAmount || 0) + refund);
  payment.refundStatus = completed ? DRIVER_HIRE_REFUND_STATUS.REFUNDED : DRIVER_HIRE_REFUND_STATUS.PENDING;
  payment.refundReason = note.slice(0, 500);
  await payment.save({ session });
  await audit({ actorRole: 'admin', actorId: adminId, action: 'PAYMENT_REFUND', entityType: 'DriverHirePayment', entityId: payment._id, changeSummary: { amount: refund, reason: note, completed }, session });
  return serializePayment(payment);
};
