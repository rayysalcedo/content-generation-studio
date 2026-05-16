// lib/funnel-push.js — Push AI-generated funnel content to a CC360 sub-account by
// updating Custom Values + uploading associated media (instructor photo, module
// thumbnails, laptop mockup) to the GHL media library.
//
// Flow:
//   1. List existing Custom Values in the target sub-account
//      (so we can match names to IDs — the PUT endpoint is ID-based)
//   2. For each image (instructor + 8 modules + laptop): upload to media library,
//      stuff resulting URL into the merge map
//   3. For each name in the merge map: PUT /locations/{lid}/customValues/{cvId}
//      (or POST if it doesn't exist yet — we tolerate both)
//
// Errors are collected per-value so a single failed update doesn't break the rest.
//
import axios from 'axios';
import { uploadToMediaLibrary } from './upload-media.js';

const PUBLIC_API = 'https://services.leadconnectorhq.com';

// =====================================================================
// Custom Values API
// =====================================================================

/**
 * List all custom values for a sub-account.
 * Returns array of { id, name, value }.
 *
 * Endpoint shape (per HighLevel docs):
 *   GET /locations/{locationId}/customValues
 *   → { customValues: [ { id, name, value, locationId, ... }, ... ] }
 */
export async function listCustomValues({ token, locationId }) {
  const url = `${PUBLIC_API}/locations/${encodeURIComponent(locationId)}/customValues`;
  const { data } = await axios.get(url, {
    headers: ghlHeaders(token),
    timeout: 30000,
  });
  // Defensive: API has used both shapes in the past
  return Array.isArray(data) ? data : (data?.customValues || []);
}

/**
 * Update an existing custom value by ID.
 *   PUT /locations/{locationId}/customValues/{customValueId}
 *   body: { name, value }   ← name must be included or GHL rejects with 400
 */
export async function updateCustomValue({ token, locationId, customValueId, name, value }) {
  const url = `${PUBLIC_API}/locations/${encodeURIComponent(locationId)}/customValues/${encodeURIComponent(customValueId)}`;
  const { data } = await axios.put(url, { name, value: String(value ?? '') }, {
    headers: ghlHeaders(token),
    timeout: 30000,
  });
  return data;
}

/**
 * Create a new custom value (if a name doesn't exist yet in the sub-account).
 *   POST /locations/{locationId}/customValues
 *   body: { name, value }
 *
 * In normal operation the snapshot should ship every name already. This function
 * exists as a self-heal for setups where someone added a new merge tag to the
 * template without creating the corresponding custom value first.
 */
export async function createCustomValue({ token, locationId, name, value }) {
  const url = `${PUBLIC_API}/locations/${encodeURIComponent(locationId)}/customValues`;
  const { data } = await axios.post(url, { name, value: String(value ?? '') }, {
    headers: ghlHeaders(token),
    timeout: 30000,
  });
  return data;
}

function ghlHeaders(token) {
  return {
    'accept': 'application/json',
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
    'version': '2021-07-28',
  };
}

// =====================================================================
// Helper — match a name against the existing custom values list.
// GHL is case-sensitive on `name`, but some setups inadvertently camelCase or
// Title Case names. We match exact first, then case-insensitive as a fallback.
// =====================================================================
function findByName(list, name) {
  const exact = list.find(cv => cv.name === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  return list.find(cv => (cv.name || '').toLowerCase() === lower) || null;
}

// =====================================================================
// High-level: push the full content map to the sub-account.
//
// @param {Object} opts
// @param {string} opts.token            - Bearer (OAuth-minted location token)
// @param {string} opts.locationId
// @param {Object<string,string>} opts.valueMap  - { customValueName -> stringValue }
// @param {Function} [opts.onProgress]
// @returns {Promise<{ updated: Array, failed: Array, created: Array }>}
// =====================================================================
export async function pushCustomValues({ token, locationId, valueMap, onProgress = () => {} }) {
  // 1. Fetch the full list once
  let existing;
  try {
    existing = await listCustomValues({ token, locationId });
  } catch (e) {
    const status = e.response?.status;
    const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 400) : e.message;
    throw new Error(`Failed to list custom values (HTTP ${status || '?'}): ${body}`);
  }

  const updated = [];
  const failed = [];
  const created = [];
  const names = Object.keys(valueMap);
  let done = 0;

  for (const name of names) {
    const value = valueMap[name];
    if (value === undefined || value === null) { done++; continue; }
    const existingCv = findByName(existing, name);

    try {
      if (existingCv?.id) {
        await updateCustomValue({
          token, locationId,
          customValueId: existingCv.id,
          name: existingCv.name,       // echo the existing name exactly — GHL is strict
          value,
        });
        updated.push({ name, id: existingCv.id });
      } else {
        // Self-heal: name doesn't exist yet — create it
        const result = await createCustomValue({ token, locationId, name, value });
        created.push({ name, id: result?.customValue?.id || result?.id || null });
      }
    } catch (e) {
      const status = e.response?.status;
      const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
      failed.push({ name, error: `HTTP ${status || '?'} ${body}` });
    }
    done++;
    if (done % 10 === 0 || done === names.length) {
      onProgress({ done, total: names.length, updated: updated.length, created: created.length, failed: failed.length });
    }
  }

  return { updated, failed, created };
}

// =====================================================================
// Upload an instructor photo from a Buffer (user-uploaded via the form).
// Returns the public URL suitable for stuffing into `instructor_photo_url`.
// =====================================================================
export async function uploadInstructorPhoto({ token, locationId, buffer, filename, mimeType = 'image/jpeg' }) {
  const { url } = await uploadToMediaLibrary({
    pit: token,                       // works with both OAuth Bearer + PIT — same endpoint
    locationId,
    buffer,
    filename: filename || `instructor-${Date.now()}.jpg`,
    contentType: mimeType,
  });
  return url;
}

// =====================================================================
// Upload all AI-generated funnel images from a base64 map.
//
// @param {Object} opts
// @param {string} opts.token
// @param {string} opts.locationId
// @param {Object<string,string>} opts.imageMap  - { "module_1": b64, ..., "pricing_laptop": b64 }
// @param {string} [opts.coursePrefix] - used in filename for traceability
// @returns {Promise<{ urls: Object<string,string>, failed: Array }>}
//   urls maps each input key to the public media URL.
// =====================================================================
export async function uploadFunnelImages({ token, locationId, imageMap, coursePrefix = 'funnel' }) {
  const urls = {};
  const failed = [];
  const keys = Object.keys(imageMap || {});

  for (const key of keys) {
    const b64 = imageMap[key];
    if (!b64) continue;
    try {
      const buffer = Buffer.from(b64, 'base64');
      const filename = `${slug(coursePrefix, 30)}-${key}-${Date.now()}.png`;
      const { url } = await uploadToMediaLibrary({
        pit: token,
        locationId,
        buffer,
        filename,
        contentType: 'image/png',
      });
      urls[key] = url;
    } catch (e) {
      const status = e.response?.status;
      const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
      failed.push({ key, error: `HTTP ${status || '?'} ${body}` });
    }
  }
  return { urls, failed };
}

function slug(s, max = 40) {
  return String(s || '').toLowerCase()
    .replace(/[^\w\s-]/g, '').trim()
    .replace(/\s+/g, '-').slice(0, max) || 'asset';
}
