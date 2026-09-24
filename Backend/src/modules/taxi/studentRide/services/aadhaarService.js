import { Student } from '../models/Student.js';
import { STUDENT_RIDE_ERRORS } from '../constants/index.js';
import { requireOwnedStudent, studentRideError } from './studentService.js';
import { aadhaarStorage, normalizeAadhaarNumber, resetReview } from './studentIdentityService.js';

/**
 * Aadhaar OTP verification through a third-party KYC provider.
 *
 * Flow: the parent submits the number → the provider texts an OTP to the
 * Aadhaar-linked mobile → the parent submits the OTP → the provider returns the
 * holder's date of birth and name. The date of birth is then taken from the
 * provider, never from the app.
 *
 * Which provider, and its credentials, are admin settings
 * (AdminThirdPartySetting.kyc.aadhaar), never code. With none configured the
 * endpoints answer 503 AADHAAR_PROVIDER_NOT_CONFIGURED and verification stays
 * manual: the admin reviews the number's last four digits and the school ID.
 */

const PROVIDER_TIMEOUT_MS = 15_000;

const notConfigured = () => studentRideError(
  503,
  STUDENT_RIDE_ERRORS.AADHAAR_PROVIDER_NOT_CONFIGURED,
  'Aadhaar verification is not available yet. The student will be verified by our team instead.',
);

const providerFailure = (message) => studentRideError(
  422,
  STUDENT_RIDE_ERRORS.AADHAAR_VERIFICATION_FAILED,
  message || 'Aadhaar verification failed. Check the number and try again.',
);

/** Provider DOB as UTC midnight, matching how studentService stores dates of birth. */
const parseProviderDob = (value) => {
  const raw = String(value || '').trim();
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let date = null;

  if (match) {
    date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  } else if ((match = raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/))) {
    date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  }

  return date && !Number.isNaN(date.getTime()) ? date : null;
};

const postJson = async (url, body, headers) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, json };
  } catch (error) {
    // Never log the request body: it carries the Aadhaar number.
    console.error('[aadhaar] provider request failed', error?.name || 'error');
    throw providerFailure('The verification service did not respond. Try again shortly.');
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Providers. Each implements
 *   generateOtp(aadhaarNumber) → { referenceId }
 *   submitOtp({ referenceId, otp }) → { dob, name }
 */
const PROVIDERS = {
  /**
   * Development and QA only — refused in production. OTP is always 123456 and
   * the date of birth is the one configured in the sandbox settings.
   */
  sandbox: (settings) => ({
    generateOtp: async () => ({ referenceId: `sandbox-${Date.now()}` }),
    submitOtp: async ({ otp }) => {
      if (String(otp) !== '123456') {
        throw providerFailure('Incorrect OTP.');
      }
      return { dob: settings?.sandbox?.dob || '2014-08-12', name: settings?.sandbox?.name || 'Sandbox Student' };
    },
  }),

  /**
   * Surepass Aadhaar v2 (OTP). Built from Surepass's published API and not yet
   * exercised against a live account — test with the sandbox base URL they
   * issue before switching enabled on.
   */
  surepass: (settings) => {
    const baseUrl = String(settings?.surepass?.base_url || 'https://kyc-api.surepass.io').replace(/\/+$/, '');
    const token = String(settings?.surepass?.token || '');

    if (!token) {
      throw notConfigured();
    }

    const headers = { Authorization: `Bearer ${token}` };

    return {
      generateOtp: async (aadhaarNumber) => {
        const { ok, json } = await postJson(`${baseUrl}/api/v1/aadhaar-v2/generate-otp`, { id_number: aadhaarNumber }, headers);
        const referenceId = json?.data?.client_id;

        if (!ok || !referenceId || json?.data?.otp_sent === false) {
          throw providerFailure(json?.message);
        }

        return { referenceId };
      },
      submitOtp: async ({ referenceId, otp }) => {
        const { ok, json } = await postJson(`${baseUrl}/api/v1/aadhaar-v2/submit-otp`, { client_id: referenceId, otp: String(otp) }, headers);

        if (!ok || !json?.data) {
          throw providerFailure(json?.message || 'Incorrect OTP.');
        }

        return { dob: json.data.dob, name: json.data.full_name || '' };
      },
    };
  },
};

const loadSettings = async () => {
  const { AdminThirdPartySetting } = await import('../../admin/models/AdminThirdPartySetting.js');
  const doc = await AdminThirdPartySetting.findOne({ scope: 'default' }).select('kyc').lean();
  return doc?.kyc?.aadhaar || {};
};

export const resolveAadhaarProvider = async () => {
  const settings = await loadSettings();
  const name = String(settings.provider || '').toLowerCase();

  if (!settings.enabled || !PROVIDERS[name]) {
    throw notConfigured();
  }

  if (name === 'sandbox' && process.env.NODE_ENV === 'production' && process.env.AADHAAR_ALLOW_SANDBOX !== 'true') {
    throw notConfigured();
  }

  return { name, provider: PROVIDERS[name](settings) };
};

/** Step 1: send the Aadhaar OTP. The number is stored (encrypted) as soon as it is valid. */
export const initiateAadhaarVerification = async ({ userId, payload }) => {
  const student = await requireOwnedStudent(
    { studentId: payload?.student_id ?? payload?.studentId, userId },
    { allowInactive: true },
  );
  const digits = normalizeAadhaarNumber(payload?.aadhaar_number ?? payload?.aadhaarNumber ?? payload?.aadhar_number);

  // Checked before any provider call, so an unconfigured provider costs nothing.
  const { name, provider } = await resolveAadhaarProvider();
  const { referenceId } = await provider.generateOtp(digits);

  const full = await Student.findById(student._id).select('+aadhaar.encrypted +aadhaar.lookup +aadhaar.referenceId');
  const storage = aadhaarStorage(digits);

  if (full.aadhaar?.lookup !== storage.lookup) {
    full.aadhaar = { ...storage, verified: false, verifiedAt: null, provider: '', providerName: '' };
    resetReview(full);
  }

  full.aadhaar.referenceId = referenceId;
  full.aadhaar.initiatedAt = new Date();
  full.aadhaar.provider = name;
  await full.save();

  return { studentId: String(full._id), otpSent: true, last4: storage.last4 };
};

/**
 * Step 2: submit the OTP. On success the date of birth is replaced by the
 * provider's and the Aadhaar is marked verified. The student still goes to the
 * admin for approval — this proves the number, not the enrolment.
 */
export const verifyAadhaarOtp = async ({ userId, payload }) => {
  const student = await requireOwnedStudent(
    { studentId: payload?.student_id ?? payload?.studentId, userId },
    { allowInactive: true },
  );
  const full = await Student.findById(student._id).select('+aadhaar.referenceId +aadhaar.lookup');

  if (!full.aadhaar?.referenceId) {
    throw studentRideError(409, STUDENT_RIDE_ERRORS.AADHAAR_NOT_INITIATED, 'Request the Aadhaar OTP first.');
  }

  const { provider } = await resolveAadhaarProvider();
  const result = await provider.submitOtp({ referenceId: full.aadhaar.referenceId, otp: payload?.otp });
  const dob = parseProviderDob(result.dob);

  if (!dob) {
    throw providerFailure('The verification service did not return a date of birth.');
  }

  const dobChanged = !full.dateOfBirth || new Date(full.dateOfBirth).getTime() !== dob.getTime();

  full.dateOfBirth = dob;
  full.aadhaar.verified = true;
  full.aadhaar.verifiedAt = new Date();
  full.aadhaar.providerName = String(result.name || '').trim();
  full.aadhaar.referenceId = '';

  if (dobChanged) {
    resetReview(full);
  }

  await full.save();

  const { serializeStudent } = await import('./studentService.js');
  return serializeStudent(full);
};
