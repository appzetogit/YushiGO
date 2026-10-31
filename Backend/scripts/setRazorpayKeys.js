/**
 * Set the Razorpay keys used for payments, the same way the admin panel does.
 * Prompts for the values so they never land in shell history or the repo.
 *
 *   node scripts/setRazorpayKeys.js
 *
 * Asks for mode (test/live), Key ID and Key Secret, checks the pair against
 * Razorpay, then saves it and enables Razorpay. Nothing is saved if Razorpay
 * rejects the keys.
 */
import readline from 'node:readline';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const { updatePaymentSettings } = await import('../src/modules/taxi/admin/services/adminService.js');

const rl = readline.createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();
const ask = async (question) => {
  process.stdout.write(question);
  const { value } = await lines.next();
  return String(value ?? '').trim();
};

const run = async () => {
  const mode = ((await ask('Mode (test/live) [test]: ')) || 'test').toLowerCase();
  if (!['test', 'live'].includes(mode)) {
    throw new Error('Mode must be "test" or "live"');
  }

  const keyId = await ask('Razorpay Key ID: ');
  const keySecret = await ask('Razorpay Key Secret: ');
  rl.close();

  if (!keyId.startsWith(`rzp_${mode}_`)) {
    throw new Error(`Key ID should start with rzp_${mode}_ for ${mode} mode`);
  }
  if (!keySecret) {
    throw new Error('Key Secret is required');
  }

  const response = await fetch('https://api.razorpay.com/v1/orders?count=1', {
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(`Razorpay rejected these keys (${response.status}): ${payload?.error?.description || 'unknown error'}`);
  }
  console.log('Razorpay accepted the keys.');

  await mongoose.connect(process.env.MONGODB_URI);
  const prefix = mode === 'live' ? 'live' : 'test';
  await updatePaymentSettings({
    razor_pay: {
      enabled: '1',
      environment: mode,
      [`${prefix}_api_key`]: keyId,
      [`${prefix}_secret_key`]: keySecret,
    },
  });
  const { active_gateway: active } = await updatePaymentSettings({});
  console.log(`Saved Razorpay ${mode} keys (Key ID ${keyId}). Active gateway: ${active?.label || 'none'}.`);
  if (active?.slug !== 'razor_pay') {
    console.log('Warning: another gateway is enabled and takes priority. Disable it in the admin panel so Razorpay is used.');
  }
};

try {
  await run();
} catch (error) {
  console.error(`Failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
  await mongoose.disconnect().catch(() => {});
}
