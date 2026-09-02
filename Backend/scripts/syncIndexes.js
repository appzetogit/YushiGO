/**
 * Build the indexes declared on every Mongoose schema.
 *
 * `autoIndex` is disabled in production (src/config/database.js), so indexes
 * declared in the schemas are never created by the app itself. Run this after
 * any deploy that adds or changes an index:
 *
 *   node scripts/syncIndexes.js
 *
 * syncIndexes() creates what is missing and drops indexes no longer declared,
 * so the database ends up matching the schemas exactly. `_id_` is never touched.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const collectModelFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collectModelFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js') && path.basename(dir) === 'models') {
      files.push(full);
    }
  }

  return files;
};

const run = async () => {
  const modelFiles = await collectModelFiles(rootDir);

  for (const file of modelFiles) {
    await import(pathToFileURL(file).href);
  }

  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

  const modelNames = mongoose.modelNames().sort();
  console.log(`Registered models: ${modelNames.length}`);

  let created = 0;
  let failed = 0;

  for (const name of modelNames) {
    const model = mongoose.model(name);

    try {
      const dropped = await model.syncIndexes();
      const indexes = await model.collection.indexes();

      console.log(`  ${name} -> ${indexes.length} index(es)${dropped.length ? `, dropped ${dropped.join(', ')}` : ''}`);
      created += indexes.length;
    } catch (error) {
      failed += 1;
      console.error(`  ${name} -> FAILED: ${error.message}`);
    }
  }

  console.log(`Done. ${created} index(es) present across ${modelNames.length} model(s), ${failed} failure(s).`);

  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
