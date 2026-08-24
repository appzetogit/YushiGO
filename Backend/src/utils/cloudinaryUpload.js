import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blob } from 'node:buffer';
import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';

const DATA_URL_PATTERN = /^data:([^;]+);base64,(.+)$/;

const UPLOADS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');

const isCloudinaryConfigured = () =>
  Boolean(env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret);

// Keep folder/publicId from escaping the uploads root via '..' or absolute paths.
const sanitizeSegment = (value = '') =>
  String(value)
    .split('/')
    .map((part) => part.replace(/[^a-zA-Z0-9_-]/g, ''))
    .filter(Boolean)
    .join('/');

/**
 * Disk fallback used when Cloudinary is not configured. Writes under Backend/uploads
 * and returns the same shape as the Cloudinary helpers, so callers need no branching.
 * Files are served by the `/uploads` static mount in app.js.
 */
const storeBufferLocally = async ({ buffer, folder, publicId, extension, mimeType, resourceType = 'image' }) => {
  const safeFolder = sanitizeSegment(folder) || 'general';
  const safeExtension = sanitizeSegment(extension) || 'bin';
  const safePublicId = sanitizeSegment(publicId) || `upload-${Date.now()}`;
  const targetDir = path.join(UPLOADS_ROOT, safeFolder);

  await fs.mkdir(targetDir, { recursive: true });

  const fileName = `${safePublicId}.${safeExtension}`;
  await fs.writeFile(path.join(targetDir, fileName), buffer);

  const relativeUrl = `/uploads/${safeFolder}/${fileName}`;
  const base = String(env.publicBackendUrl || '').replace(/\/+$/, '');

  return {
    secureUrl: base ? `${base}${relativeUrl}` : relativeUrl,
    publicId: `${safeFolder}/${safePublicId}`,
    resourceType,
    format: safeExtension,
    bytes: buffer.length,
    mimeType,
    storage: 'local',
    raw: { storage: 'local', path: relativeUrl },
  };
};

const parseDataUrl = (dataUrl) => {
  const match = String(dataUrl || '').match(DATA_URL_PATTERN);

  if (!match) {
    throw new ApiError(400, 'A valid base64 image data URL is required');
  }

  const mimeType = match[1];
  const base64 = match[2];
  const extension = mimeType.split('/')[1] || 'jpg';

  return {
    mimeType,
    base64,
    extension,
  };
};

const buildSignature = (params, apiSecret) => {
  const payload = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return crypto.createHash('sha1').update(`${payload}${apiSecret}`).digest('hex');
};

export const uploadDataUrlToCloudinary = async ({
  dataUrl,
  folder = env.cloudinary.folder,
  publicIdPrefix = 'driver-document',
  publicIdSuffix = '',
}) => {
  const { mimeType, base64, extension } = parseDataUrl(dataUrl);
  const buffer = Buffer.from(base64, 'base64');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const publicId = `${publicIdPrefix}-${Date.now()}${publicIdSuffix ? `-${publicIdSuffix}` : ''}`;

  if (!isCloudinaryConfigured()) {
    return storeBufferLocally({ buffer, folder, publicId, extension, mimeType });
  }

  const signature = buildSignature(
    {
      folder,
      format: 'webp',
      public_id: publicId,
      timestamp,
    },
    env.cloudinary.apiSecret,
  );

  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: mimeType }), `upload.${extension}`);
  formData.append('api_key', env.cloudinary.apiKey);
  formData.append('timestamp', timestamp);
  formData.append('folder', folder);
  formData.append('public_id', publicId);
  formData.append('format', 'webp');
  formData.append('signature', signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${env.cloudinary.cloudName}/image/upload`, {
    method: 'POST',
    body: formData,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(response.status || 502, payload?.error?.message || 'Cloudinary upload failed');
  }

  return {
    secureUrl: payload.secure_url,
    publicId: payload.public_id,
    resourceType: payload.resource_type,
    format: payload.format,
    bytes: payload.bytes,
    width: payload.width,
    height: payload.height,
    originalFilename: payload.original_filename,
    createdAt: payload.created_at,
    raw: payload,
  };
};

export const uploadRawFileToCloudinary = async ({
  dataUrl,
  folder = env.cloudinary.folder,
  publicIdPrefix = 'career-resume',
  publicIdSuffix = '',
}) => {
  const { mimeType, base64, extension } = parseDataUrl(dataUrl);
  const buffer = Buffer.from(base64, 'base64');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const publicId = `${publicIdPrefix}-${Date.now()}${publicIdSuffix ? `-${publicIdSuffix}` : ''}`;

  const isImage = mimeType.startsWith('image/');
  const resourceType = isImage ? 'image' : 'raw';

  if (!isCloudinaryConfigured()) {
    return storeBufferLocally({ buffer, folder, publicId, extension, mimeType, resourceType });
  }

  const params = {
    folder,
    public_id: publicId,
    timestamp,
  };
  if (isImage) {
    params.format = 'webp';
  }

  const signature = buildSignature(params, env.cloudinary.apiSecret);

  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: mimeType }), `upload.${extension}`);
  formData.append('api_key', env.cloudinary.apiKey);
  formData.append('timestamp', timestamp);
  formData.append('folder', folder);
  formData.append('public_id', publicId);
  if (isImage) {
    formData.append('format', 'webp');
  }
  formData.append('signature', signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${env.cloudinary.cloudName}/${resourceType}/upload`, {
    method: 'POST',
    body: formData,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(response.status || 502, payload?.error?.message || 'Cloudinary upload failed');
  }

  return {
    secureUrl: payload.secure_url,
    publicId: payload.public_id,
    resourceType: payload.resource_type,
    format: payload.format,
    bytes: payload.bytes,
    raw: payload,
  };
};
