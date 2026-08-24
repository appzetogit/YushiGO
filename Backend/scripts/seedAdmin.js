/**
 * Seed script: create or update the default admin account.
 *
 * Usage:
 *   node scripts/seedAdmin.js
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=secret node scripts/seedAdmin.js
 *
 * Credentials come from env so they are never committed to the repo.
 */

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { Admin } = await import('../src/modules/taxi/admin/models/Admin.js');

const MONGO_URI = process.env.MONGODB_URI;
const MONGO_DB = process.env.MONGODB_DB_NAME || 'appzeto_taxi';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@admin.com').toLowerCase().trim();
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '123456';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Super Admin';

if (!MONGO_URI) {
  console.error('MONGODB_URI is not set in .env');
  process.exit(1);
}

if (String(ADMIN_PASS).length < 5) {
  console.error('ADMIN_PASSWORD must be at least 5 characters');
  process.exit(1);
}

try {
  await mongoose.connect(MONGO_URI, { dbName: MONGO_DB });
  console.log(`Connected to MongoDB (${MONGO_DB})`);

  const password = await bcrypt.hash(ADMIN_PASS, 10);

  // admin_type must be 'superadmin' — the panel grants full menu access on that
  // field, not on `role`. A blank admin_type yields an admin who sees nothing.
  const doc = {
    name: ADMIN_NAME,
    password,
    role: 'superadmin',
    admin_type: 'superadmin',
    permissions: ['*'],
    active: true,
  };

  const existing = await Admin.findOne({ email: ADMIN_EMAIL });

  if (existing) {
    await Admin.updateOne({ email: ADMIN_EMAIL }, { $set: doc });
    console.log('Admin already existed — updated.');
  } else {
    await Admin.create({ ...doc, email: ADMIN_EMAIL });
    console.log('Admin created.');
  }

  console.log(`\n  Email : ${ADMIN_EMAIL}`);
  console.log(`  Type  : superadmin (full access)\n`);
} catch (error) {
  console.error('Seed failed:', error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
