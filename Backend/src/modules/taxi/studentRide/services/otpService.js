import crypto from 'node:crypto';
import { STUDENT_RIDE_ERROR_CODES, studentRideConfig } from '../constants/index.js';
import { studentRideError } from './studentService.js';

/**
 * Pickup and drop codes for a student ride (§19–§21).
 *
 * The plaintext leaves this module exactly once, at issue. Everything stored is
 * a hash, so neither a database dump nor a log line yields a code that would let
 * someone collect a child.
 */

const hashOtp = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');

/**
 * Uniform random digits from a CSPRNG.
 *
 * `crypto.randomInt` is used rather than modulo over random bytes, which skews
 * toward low digits — a bias worth avoiding in a code that protects a child.
 */
const generateOtp = (length) => Array.from(
  { length },
  () => crypto.randomInt(0, 10),
).join('');

/**
 * Mint a code and return the plaintext alongside the fields to persist.
 *
 * The caller is responsible for delivering the plaintext and then discarding it;
 * it is never written to the ride document.
 */
export const issueOtp = () => {
  const config = studentRideConfig();
  const otp = generateOtp(config.otpLength);
  const now = new Date();

  return {
    otp,
    fields: {
      hash: hashOtp(otp),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + (config.otpExpirySeconds * 1000)),
      verifiedAt: null,
      attempts: 0,
    },
  };
};

/**
 * Check a submitted code against a stored one.
 *
 * Returns the mutations the caller should persist rather than applying them, so
 * the attempt counter is written inside the caller's transaction and a failed
 * attempt cannot be lost to a rollback.
 */
export const verifyOtp = ({ stored, submitted, label }) => {
  const config = studentRideConfig();
  const candidate = String(submitted || '').trim();

  if (!stored?.hash) {
    throw studentRideError(409, STUDENT_RIDE_ERROR_CODES.INVALID_OTP, `No ${label} OTP has been issued.`);
  }

  // One-time use: a verified code is spent, and replaying it is refused even
  // while it is still inside its expiry window.
  if (stored.verifiedAt) {
    throw studentRideError(
      409,
      STUDENT_RIDE_ERROR_CODES.OTP_ALREADY_VERIFIED,
      `This ${label} OTP has already been used.`,
    );
  }

  if (stored.attempts >= config.otpMaxAttempts) {
    throw studentRideError(
      429,
      STUDENT_RIDE_ERROR_CODES.OTP_ATTEMPTS_EXCEEDED,
      'Too many incorrect attempts. Ask for a new code.',
    );
  }

  if (stored.expiresAt && stored.expiresAt.getTime() <= Date.now()) {
    throw studentRideError(410, STUDENT_RIDE_ERROR_CODES.OTP_EXPIRED, `This ${label} OTP has expired.`);
  }

  if (!/^\d+$/.test(candidate)) {
    return { verified: false, attempts: stored.attempts + 1 };
  }

  const submittedHash = hashOtp(candidate);
  const storedBuffer = Buffer.from(stored.hash, 'utf8');
  const submittedBuffer = Buffer.from(submittedHash, 'utf8');

  // Constant-time comparison. Both sides are fixed-length sha256 hex, so the
  // lengths always match and timingSafeEqual cannot throw here.
  const matches = storedBuffer.length === submittedBuffer.length
    && crypto.timingSafeEqual(storedBuffer, submittedBuffer);

  if (!matches) {
    return { verified: false, attempts: stored.attempts + 1 };
  }

  return { verified: true, attempts: stored.attempts, verifiedAt: new Date() };
};

/** Safe to return anywhere: says whether a code is live, never what it is. */
export const serializeOtpState = (stored) => ({
  issued: Boolean(stored?.issuedAt),
  verified: Boolean(stored?.verifiedAt),
  verifiedAt: stored?.verifiedAt || null,
  expiresAt: stored?.expiresAt || null,
  attemptsRemaining: Math.max(0, studentRideConfig().otpMaxAttempts - (stored?.attempts || 0)),
});
