// lib/token-store.js — Persists Sub-Account OAuth installations.
//
// Two backends, selected automatically by env:
//   • Postgres (when DATABASE_URL is set) — recommended for production, survives redeploys
//   • Local JSON file (fallback when no DATABASE_URL) — fine for local dev only;
//     on Render free tier the file gets wiped every deploy
//
// All exported functions return PROMISES (always async, regardless of backend) so
// callers can use a single consistent `await` pattern.
//
// Postgres schema (auto-created on boot):
//   CREATE TABLE installations (
//     location_id TEXT PRIMARY KEY,
//     payload     JSONB NOT NULL,
//     updated_at  TIMESTAMPTZ DEFAULT NOW()
//   );
//
import fs from 'fs';
import path from 'path';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const DATA_DIR     = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const INSTALL_FILE = path.join(DATA_DIR, 'installations.json');

// ====================================================================
// Backend selection — Postgres if DATABASE_URL is set, else file
// ====================================================================
const USE_PG = !!DATABASE_URL;
let pool = null;
let ready = null;           // Promise that resolves once table is ensured

if (USE_PG) {
  pool = new pg.Pool({
    connectionString: DATABASE_URL,
    // Render's managed Postgres requires SSL. rejectUnauthorized:false is normal
    // for managed DBs that use their own CA; the connection is still encrypted.
    ssl: DATABASE_URL.includes('render.com') || DATABASE_URL.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : false,
  });

  ready = pool.query(`
    CREATE TABLE IF NOT EXISTS installations (
      location_id  TEXT PRIMARY KEY,
      payload      JSONB NOT NULL,
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => {
    console.log(`✅ Postgres token store ready (DATABASE_URL set)`);
  }).catch(e => {
    console.error(`❌ Postgres init failed: ${e.message}`);
    console.error(`   Token store will NOT work. Check your DATABASE_URL env var.`);
    throw e;
  });
} else {
  ready = Promise.resolve();
  // Note that we're using the (volatile) file backend
  if (process.env.NODE_ENV !== 'test') {
    console.log(`⚠️  Token store using local file (${INSTALL_FILE}). Set DATABASE_URL for persistence.`);
  }
}

// ====================================================================
// Postgres backend
// ====================================================================
async function pgGet(locationId) {
  await ready;
  const { rows } = await pool.query(
    'SELECT payload FROM installations WHERE location_id = $1',
    [locationId]
  );
  return rows[0]?.payload || null;
}

async function pgList() {
  await ready;
  const { rows } = await pool.query(
    'SELECT payload FROM installations ORDER BY updated_at DESC'
  );
  return rows.map(r => r.payload);
}

async function pgSave(install) {
  if (!install?.locationId) throw new Error('saveInstallation requires locationId');
  await ready;
  // Merge with existing record so partial updates (e.g. refresh-only) preserve other fields.
  const existing = (await pool.query(
    'SELECT payload FROM installations WHERE location_id = $1',
    [install.locationId]
  )).rows[0]?.payload || {};
  const merged = { ...existing, ...install };
  await pool.query(
    `INSERT INTO installations (location_id, payload, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (location_id) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = NOW()`,
    [install.locationId, JSON.stringify(merged)]
  );
  return merged;
}

async function pgDelete(locationId) {
  await ready;
  await pool.query('DELETE FROM installations WHERE location_id = $1', [locationId]);
}

// ====================================================================
// File backend (fallback)
// ====================================================================
function fileReadAll() {
  try {
    if (!fs.existsSync(INSTALL_FILE)) return {};
    const raw = fs.readFileSync(INSTALL_FILE, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`⚠️  Failed to read ${INSTALL_FILE}: ${e.message}`);
    return {};
  }
}

function fileWriteAll(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = INSTALL_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, INSTALL_FILE);
}

async function fileGet(locationId) {
  return fileReadAll()[locationId] || null;
}

async function fileList() {
  return Object.values(fileReadAll());
}

async function fileSave(install) {
  if (!install?.locationId) throw new Error('saveInstallation requires locationId');
  const data = fileReadAll();
  data[install.locationId] = { ...(data[install.locationId] || {}), ...install };
  fileWriteAll(data);
  return data[install.locationId];
}

async function fileDelete(locationId) {
  const data = fileReadAll();
  delete data[locationId];
  fileWriteAll(data);
}

// ====================================================================
// Public API — routes to whichever backend is active. ALL ASYNC.
// ====================================================================
export const getInstallation    = (locationId) => USE_PG ? pgGet(locationId)    : fileGet(locationId);
export const listInstallations  = ()           => USE_PG ? pgList()             : fileList();
export const saveInstallation   = (install)    => USE_PG ? pgSave(install)      : fileSave(install);
export const deleteInstallation = (locationId) => USE_PG ? pgDelete(locationId) : fileDelete(locationId);

export const store = { getInstallation, listInstallations, saveInstallation, deleteInstallation };

// Useful for boot logs / health checks
export function backendName() { return USE_PG ? 'postgres' : 'file'; }