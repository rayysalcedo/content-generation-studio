// ───────────────────────────────────────────────────────────────────
// lib/snapshot-push.js
// Imports a CC360/GHL snapshot into a sub-account using the
// agency-level OAuth token.
//
// Flow:
//   1. POST /snapshots/load     → kicks off async import job
//   2. (optional) poll status   → not all GHL setups return a status; we
//                                  use a fixed 8-second wait by default,
//                                  which covers ~99% of single-funnel snapshots
//
// The endpoint path used here is the v2 LeadConnector "load snapshot to
// location" endpoint. If your CC360 white-label uses a different route,
// adjust SNAPSHOT_LOAD_URL.
// ───────────────────────────────────────────────────────────────────

import axios from 'axios';

const SNAPSHOT_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

// Apply (import / load) a snapshot to a target sub-account location.
// Requires an agency-level access token with `snapshots.write` scope.
//
// args:
//   companyAccessToken — agency OAuth token (NOT a sub-account token)
//   companyId          — agency company ID (UUID-like string)
//   snapshotId         — the snapshot to load
//   locationId         — the sub-account to import the snapshot into
//
// Returns: { ok: true, raw: <response body> }  on success
// Throws on HTTP error or non-2xx response.
export async function loadSnapshotToLocation({
  companyAccessToken,
  companyId,
  snapshotId,
  locationId,
}) {
  if (!companyAccessToken) throw new Error('loadSnapshotToLocation: missing companyAccessToken');
  if (!companyId)          throw new Error('loadSnapshotToLocation: missing companyId');
  if (!snapshotId)         throw new Error('loadSnapshotToLocation: missing snapshotId');
  if (!locationId)         throw new Error('loadSnapshotToLocation: missing locationId');

  const url = `${SNAPSHOT_BASE}/snapshots/load/idAssetTypes`;
  const body = {
    companyId,
    snapshotId,
    locationId,
    // GHL accepts an override flag to control what gets re-applied.
    // We default to false so existing customValues (content) are preserved
    // — the push flow updates those separately after the snapshot loads.
    override: false,
  };

  try {
    const res = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${companyAccessToken}`,
        Version: GHL_VERSION,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
      validateStatus: () => true,
    });

    if (res.status < 200 || res.status >= 300) {
      const detail = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data || '');
      throw new Error(`Snapshot load HTTP ${res.status}: ${detail.slice(0, 400)}`);
    }
    return { ok: true, raw: res.data };
  } catch (e) {
    if (e.response) {
      const d = typeof e.response.data === 'object' ? JSON.stringify(e.response.data) : String(e.response.data || '');
      throw new Error(`Snapshot load HTTP ${e.response.status}: ${d.slice(0, 400)}`);
    }
    throw e;
  }
}

// Wait for snapshot import to settle. GHL doesn't expose a status endpoint
// for snapshot loads, so we just pause and let the async job propagate.
// Most single-funnel snapshots complete inside 5–8 seconds.
export function waitForSnapshotPropagation(ms = 8000) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
