// lib/token-store.js — Persists Sub-Account OAuth installations to disk.
//
// In the Sub-Account OAuth model, each installation IS a sub-account token —
// no minting step needed. We key installations by locationId.
//
// Storage shape (one JSON file in DATA_DIR):
//   installations.json — { [locationId]: { locationId, companyId, accessToken,
//                                          refreshToken, expiresAt, scopes,
//                                          installedAt, locationName?, companyName? } }
//
// Notes:
// - Atomic writes (tmp + rename) to avoid partial reads under concurrent writes.
// - DATA_DIR defaults to ./data — on Render, mount a Persistent Disk at this path
//   ($0.25/GB/mo) so tokens survive deploys.
//
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const INSTALL_FILE = path.join(DATA_DIR, 'installations.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error(`⚠️  Failed to read ${file}: ${e.message}`);
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------
// Sub-Account installations — keyed by locationId
// ---------------------------------------------------------------------
export function getInstallation(locationId) {
  const data = readJson(INSTALL_FILE);
  return data[locationId] || null;
}

export function listInstallations() {
  const data = readJson(INSTALL_FILE);
  return Object.values(data);
}

export function saveInstallation(install) {
  if (!install.locationId) throw new Error('saveInstallation requires locationId');
  const data = readJson(INSTALL_FILE);
  data[install.locationId] = { ...(data[install.locationId] || {}), ...install };
  writeJson(INSTALL_FILE, data);
  return data[install.locationId];
}

export function deleteInstallation(locationId) {
  const data = readJson(INSTALL_FILE);
  delete data[locationId];
  writeJson(INSTALL_FILE, data);
}

// ---------------------------------------------------------------------
// Store object — bundled API for oauth.js to consume
// ---------------------------------------------------------------------
export const store = {
  getInstallation,
  listInstallations,
  saveInstallation,
  deleteInstallation,
};