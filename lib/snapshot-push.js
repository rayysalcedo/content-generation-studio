// ───────────────────────────────────────────────────────────────────
// lib/snapshot-push.js
// Loads a GoHighLevel agency snapshot into a target sub-account using
// GHL's INTERNAL snapshot endpoint on backend.leadconnectorhq.com.
//
// Why the internal endpoint instead of the public Snapshots API:
//   The public Snapshots API (services.leadconnectorhq.com/snapshots/*)
//   has no "load snapshot into location" route — only list/share/push-
//   history endpoints exist. Loading a snapshot is officially a manual
//   UI action. The GoHighLevel web UI calls a private endpoint on
//   backend.leadconnectorhq.com to do it, and we mirror that call here.
//
// Why this works server-side (despite "WAF":
//   The Cloudflare WAF in front of backend.leadconnectorhq.com gates
//   requests by the Origin header, not by IP. Node can set any Origin
//   it wants, so we pass `origin: https://app.gohighlevel.com`
//   and the WAF lets us through. This is the same trick used by the
//   thumbnail-attach flow in lib/ghl.js — verified working in prod.
//
// Auth pair (NOT OAuth):
//   • authorization: Bearer <User JWT>   — the agency-admin's user-session JWT
//   • token-id: <Firebase ID token>       — CSRF-style companion header
//   Both are captured by the GoHighLevel-side Custom JS snippet and stored on
//   our server via /api/user-jwt. Use getActiveUserJwt() to fetch the
//   pair. They expire ~hourly; the snippet auto-refreshes them.
//
// Flow (per load):
//   1. GET  /snapshots-appengine/snapshot/{id}/get_assets?type=own&companyId=X
//       → returns full asset list (funnels, custom_values, etc.) with IDs
//   2. POST /snapshots-appengine/snapshot/{id}/set_assets_to_locations?companyId=X
//       → applies those assets into the target location, returns 200 "OK"
// ───────────────────────────────────────────────────────────────────

import axios from 'axios';

// Web-app origin the platform's internal API expects (set GHL_APP_ORIGIN for white-label domains).
const APP_ORIGIN = (process.env.GHL_APP_ORIGIN || 'https://app.gohighlevel.com').replace(/\/$/, '');

const BACKEND_BASE = 'https://backend.leadconnectorhq.com';

// Headers verified via Network-tab capture of the platform's "Load Snapshot" UI.
// Notably DIFFERENT from membership-API headers in lib/ghl.js:
//   • `source-id: locations` (literal string, NOT a locationId)
//   • `version: 2021-07-28` — required for v2 API (without this: 401 Unauthorized)
function snapshotHeaders(userJwt, tokenId) {
  const h = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'authorization': `Bearer ${userJwt}`,
    'content-type': 'application/json',
    'priority': 'u=1, i',
    'channel': 'APP',
    'source': 'WEB_USER',
    'source-id': 'locations',
    'version': '2021-07-28',
    'origin': APP_ORIGIN,
    'referer': APP_ORIGIN + '/',
    'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  };
  if (tokenId) h['token-id'] = tokenId;
  return h;
}

// All asset categories that GHL's snapshot payload recognizes. We send
// each as either a populated array (for what's in the snapshot) or an
// empty array (for what isn't). The skipData payload uses the same keys.
const ASSET_KEYS = [
  'folders', 'custom_fields', 'custom_values', 'tags', 'links',
  'text_templates', 'pipelines', 'surveys', 'teams', 'calendars',
  'campaigns', 'membership_offers', 'membership_products', 'triggers',
  'sectionTemplates', 'workflow', 'social_planner', 'funnels',
];

/**
 * Fetch the list of asset IDs inside a snapshot, grouped by category.
 *
 * Returns an object like:
 *   { funnels: ['LQ8EXH9...'], custom_values: ['TRpK...', ...], ...all categories... }
 * with empty arrays for categories the snapshot doesn't contain.
 *
 * The raw API response is shaped like:
 *   { folders: [], custom_values: [{id, name, parentId?, type?}, ...], funnels: [{id, name, ...}], ... }
 * We flatten to plain ID arrays for use in set_assets_to_locations.
 */
export async function fetchSnapshotAssets({
  snapshotId,
  companyId,
  userJwt,
  tokenId,
  type = 'own',
}) {
  if (!snapshotId) throw new Error('fetchSnapshotAssets: missing snapshotId');
  if (!companyId)  throw new Error('fetchSnapshotAssets: missing companyId');
  if (!userJwt)    throw new Error('fetchSnapshotAssets: missing userJwt (paste at /setup or have GoHighLevel tab open)');

  const url = `${BACKEND_BASE}/snapshots-appengine/snapshot/${encodeURIComponent(snapshotId)}/get_assets`;
  let data;
  try {
    const res = await axios.get(url, {
      params: { type, companyId },
      headers: snapshotHeaders(userJwt, tokenId),
      timeout: 30_000,
    });
    data = res.data;
  } catch (err) {
    // Surface the response body in the error message so we can diagnose 401/403/etc.
    const status = err.response?.status;
    const body = err.response?.data;
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body || {});
    const hint = status === 401
      ? ' (User JWT may be expired or missing token-id — refresh via /setup)'
      : '';
    throw new Error(`get_assets HTTP ${status || '?'}: ${bodyStr.slice(0, 400)}${hint}`);
  }

  // Flatten {id, name, ...} entries to plain ID strings per category.
  const ids = {};
  for (const key of ASSET_KEYS) {
    const arr = Array.isArray(data?.[key]) ? data[key] : [];
    ids[key] = arr.map(item =>
      typeof item === 'string' ? item : (item?.id || null)
    ).filter(Boolean);
  }
  return ids;
}

/**
 * Load a snapshot into a sub-account.
 *
 * Steps:
 *   1. Calls fetchSnapshotAssets to discover what's inside the snapshot.
 *   2. POSTs set_assets_to_locations with the full asset list selected.
 *      skipData is empty (no conflicts skipped) — GHL overrides on conflict,
 *      which is what we want for re-pushes (existing themed funnel gets
 *      replaced, not duplicated).
 *
 * Returns { ok: true, assetCounts, raw } on success.
 * Throws on HTTP error or non-2xx.
 */
export async function loadSnapshotToLocation({
  snapshotId,
  locationId,
  companyId,
  userJwt,
  tokenId,
  snapshotType = 'own',
}) {
  if (!snapshotId) throw new Error('loadSnapshotToLocation: missing snapshotId');
  if (!locationId) throw new Error('loadSnapshotToLocation: missing locationId');
  if (!companyId)  throw new Error('loadSnapshotToLocation: missing companyId');
  if (!userJwt)    throw new Error('loadSnapshotToLocation: missing userJwt (paste at /setup or have GoHighLevel tab open)');

  // Step 1 — discover what's inside the snapshot
  const assets = await fetchSnapshotAssets({ snapshotId, companyId, userJwt, tokenId, type: snapshotType });
  const assetCounts = Object.fromEntries(
    Object.entries(assets).filter(([, arr]) => arr.length > 0).map(([k, arr]) => [k, arr.length])
  );

  // Sanity check — every themed snapshot we use should have at least one funnel.
  // If the snapshot is empty or fetch failed silently, abort here with a clear error
  // rather than firing an empty load that returns 200 but does nothing.
  const total = Object.values(assets).reduce((sum, arr) => sum + arr.length, 0);
  if (total === 0) {
    throw new Error(`Snapshot ${snapshotId} has no assets (empty or get_assets returned nothing). Check the snapshot ID.`);
  }

  // Step 2 — load all discovered assets into the target sub-account
  const url = `${BACKEND_BASE}/snapshots-appengine/snapshot/${encodeURIComponent(snapshotId)}/set_assets_to_locations`;

  // selectedSnapshotAssets: every category as a populated or empty array.
  // skipData[locationId].assets: every category as an empty array (no
  // conflicts to skip). With skipAllConflicts:false and no items in
  // skip lists, GHL will OVERRIDE any conflicting asset — desired for re-push.
  const emptyAssetSlots = Object.fromEntries(ASSET_KEYS.map(k => [k, []]));
  const body = {
    selectedSnapshotAssets: { ...emptyAssetSlots, ...assets },
    skipData: {
      [locationId]: {
        assets: emptyAssetSlots,
        skipAllConflicts: false,
      },
    },
    snapshotType,
  };

  const res = await axios.post(url, body, {
    params: { companyId },
    headers: snapshotHeaders(userJwt, tokenId),
    timeout: 60_000,
    validateStatus: () => true,   // we handle non-2xx ourselves below
  });

  if (res.status < 200 || res.status >= 300) {
    const detail = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    throw new Error(`Snapshot load HTTP ${res.status}: ${String(detail).slice(0, 400)}`);
  }

  return { ok: true, assetCounts, raw: res.data };
}

/**
 * Optional propagation delay. GHL's snapshot loader returns synchronously
 * but funnel pages can take a few seconds to be queryable through other
 * endpoints (e.g. the funnels list). The push flow uses this to give the
 * subsequent custom-values write a stable target.
 */
export function waitForSnapshotPropagation(ms = 8000) {
  return new Promise(resolve => setTimeout(resolve, ms));
}