import crypto from 'node:crypto';

/**
 * OTP primitives shared by every handover code (student ride, parcel).
 *
 * Only the mechanics live here — generation, hashing, comparison. Each feature
 * keeps its own expiry, attempt limit and error vocabulary.
 */

export const hashOtp = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');

/**
 * Uniform random digits from a CSPRNG. `crypto.randomInt` rather than modulo
 * over random bytes, which skews toward low digits.
 */
export const generateOtp = (length = 4) => Array.from(
  { length },
  () => crypto.randomInt(0, 10),
).join('');

/**
 * Constant-time check of a submitted code against a stored sha256 hash.
 * Non-numeric input is a mismatch, not an error.
 */
export const otpMatches = (storedHash, submitted) => {
  const candidate = String(submitted || '').trim();

  if (!storedHash || !/^\d+$/.test(candidate)) {
    return false;
  }

  const storedBuffer = Buffer.from(String(storedHash), 'utf8');
  const submittedBuffer = Buffer.from(hashOtp(candidate), 'utf8');

  return storedBuffer.length === submittedBuffer.length
    && crypto.timingSafeEqual(storedBuffer, submittedBuffer);
};
