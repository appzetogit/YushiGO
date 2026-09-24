import crypto from 'node:crypto';

/**
 * Reversible encryption for individual sensitive fields (AES-256-GCM).
 *
 * For values the platform must show again later but must not store readable:
 * an Aadhaar number, or a delivery code the sender re-opens the app to read.
 * Anything that only ever needs checking, never showing, should be hashed
 * instead.
 *
 * Key: DATA_ENCRYPTION_KEY, 32 bytes as 64 hex characters or base64. Without
 * it the key is derived from JWT_SECRET so development and tests work, with a
 * warning — in production set the dedicated key, because rotating JWT_SECRET
 * would otherwise make every stored value unreadable.
 */

const VERSION = 'v1';
let cachedKey = null;
let warned = false;

const loadKey = () => {
  if (cachedKey) {
    return cachedKey;
  }

  const raw = String(process.env.DATA_ENCRYPTION_KEY || '').trim();

  if (raw) {
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');

    if (key.length !== 32) {
      throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64).');
    }

    cachedKey = key;
    return cachedKey;
  }

  const secret = String(process.env.JWT_SECRET || '');

  if (!secret) {
    throw new Error('DATA_ENCRYPTION_KEY (or JWT_SECRET) must be set to encrypt fields.');
  }

  if (!warned && process.env.NODE_ENV === 'production') {
    warned = true;
    console.warn('[fieldCrypto] DATA_ENCRYPTION_KEY is not set; deriving from JWT_SECRET');
  }

  cachedKey = Buffer.from(crypto.hkdfSync('sha256', secret, 'yushigo-field-crypto', 'v1', 32));
  return cachedKey;
};

/** Encrypt a string. Returns `v1:<iv>:<tag>:<ciphertext>` (base64 parts). */
export const encryptField = (plaintext) => {
  if (plaintext === null || plaintext === undefined || plaintext === '') {
    return '';
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
};

/** Decrypt a value from encryptField. Returns '' for empty or unreadable input. */
export const decryptField = (payload) => {
  const parts = String(payload || '').split(':');

  if (parts.length !== 4 || parts[0] !== VERSION) {
    return '';
  }

  try {
    const [, iv, tag, ciphertext] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // A tampered value or a changed key: unreadable, never a crash.
    return '';
  }
};

/** Deterministic keyed hash, for looking a value up without decrypting (e.g. duplicate checks). */
export const blindIndex = (value) =>
  crypto.createHmac('sha256', loadKey()).update(String(value || '')).digest('hex');
