// ───────────────────────────────────────────────────────────────────
// lib/funnel-share-push.js
// Clones a single funnel from a source agency-snapshot/sub-account into
// a target sub-account using GHL's "share funnel" internal endpoint.
//
// Why this exists alongside (and now replaces) lib/snapshot-push.js:
//   Loading a themed snapshot via /snapshots-appengine/set_assets_to_locations
//   sometimes produces a funnel that's missing page elements (custom HTML
//   blocks, certain section templates, page-builder widgets). The "Share
//   Funnel" path in CC360's UI uses /funnels/funnel/clone-funnel-to-locations
//   and produces a bit-perfect copy. We use the same endpoint here.
//
// Endpoint:
//   POST https://backend.leadconnectorhq.com/funnels/funnel/clone-funnel-to-locations
//   body: { funnelId, funnelName, locationIds: [ targetLocationId, ... ] }
//   → 201 Created with { ok: true, traceId }
//
// Auth pair:
//   • authorization: Bearer <user session JWT>
//   • token-id: <Firebase ID token>
//   The captured working request was minted by app.gohighlevel.com (HS256
//   Bearer), not by app.coursecreator360.com (RS256 Bearer). We try with
//   whatever User JWT is stored — backend.leadconnectorhq.com MAY accept
//   either format since the underlying user identity matches. If you get a
//   401, paste a fresh JWT captured from app.gohighlevel.com at /setup.
//
// WAF / Origin:
//   Origin: https://app.gohighlevel.com (NOT app.coursecreator360.com — this
//   endpoint was captured from the GHL master UI; CC360 white-label users
//   reach it via the share-link click flow which redirects to gohighlevel.com).
//   Same trick as lib/cc360.js — Node spoofs Origin since the WAF gates by
//   header, not IP.
// ───────────────────────────────────────────────────────────────────

import axios from 'axios';

const BACKEND_BASE = 'https://backend.leadconnectorhq.com';

// Headers verified via Network-tab capture of CC360/GHL "Share Funnel → Import"
// UI flow. Differs from snapshot-push.js in three places:
//   • origin: app.gohighlevel.com (NOT app.coursecreator360.com)
//   • app-name: spm-ts (sales-pipeline-management micro-app)
//   • x-translations-lang: en-US
// And NO source-id / channel: APP (which the snapshot endpoint required).
function shareHeaders(userJwt, tokenId) {
  const h = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'app-name': 'spm-ts',
    'authorization': `Bearer ${userJwt}`,
    'channel': 'APP',
    'content-type': 'application/json',
    'priority': 'u=1, i',
    'source': 'WEB_USER',
    'origin': 'https://app.gohighlevel.com',
    'referer': 'https://app.gohighlevel.com/',
    'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'x-translations-lang': 'en-US',
  };
  if (tokenId) h['token-id'] = tokenId;
  return h;
}

/**
 * Clone a funnel into one or more target sub-accounts.
 *
 * @param {Object} args
 * @param {string} args.funnelId          - Source funnel ID (lives in agency template sub-account)
 * @param {string} args.funnelName        - Display name for the new copy in the destination
 * @param {string|string[]} args.targetLocationIds - Destination sub-account ID(s)
 * @param {string} args.userJwt           - User session JWT (Bearer)
 * @param {string} [args.tokenId]         - Firebase ID token (token-id header)
 *
 * @returns {Promise<{ ok: true, raw: any, traceId?: string }>}
 * @throws on non-2xx or network error, with helpful diagnostic in message.
 */
export async function cloneFunnelToLocations({
  funnelId,
  funnelName,
  targetLocationIds,
  userJwt,
  tokenId,
}) {
  if (!funnelId)        throw new Error('cloneFunnelToLocations: missing funnelId');
  if (!targetLocationIds) throw new Error('cloneFunnelToLocations: missing targetLocationIds');
  if (!userJwt)         throw new Error('cloneFunnelToLocations: missing userJwt (paste one at /setup)');

  const locationIds = Array.isArray(targetLocationIds) ? targetLocationIds : [targetLocationIds];
  if (locationIds.length === 0) throw new Error('cloneFunnelToLocations: targetLocationIds is empty');

  const url = `${BACKEND_BASE}/funnels/funnel/clone-funnel-to-locations`;
  const body = {
    funnelId,
    funnelName: funnelName || `Funnel ${funnelId} Copy`,
    locationIds,
  };

  let res;
  try {
    res = await axios.post(url, body, {
      headers: shareHeaders(userJwt, tokenId),
      timeout: 60_000,
      validateStatus: () => true,   // we handle status ourselves
    });
  } catch (err) {
    throw new Error(`clone-funnel network error: ${err.message}`);
  }

  if (res.status < 200 || res.status >= 300) {
    const detail = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {});
    let hint = '';
    if (res.status === 401) {
      hint = ' (Bearer JWT rejected — the share endpoint may require an app.gohighlevel.com-issued JWT, not the CC360 one. Capture a fresh JWT from any logged-in app.gohighlevel.com tab and paste it at /setup.)';
    } else if (res.status === 403) {
      hint = ' (Authenticated but no permission — the User JWT\'s token-id may not include this target location. Reload your GHL master tab to refresh the locations list and try again.)';
    } else if (res.status === 404) {
      hint = ' (The funnel ID may not exist or may not be accessible to this user. Verify the funnelId by opening the funnel in CC360 and checking its URL.)';
    }
    throw new Error(`clone-funnel HTTP ${res.status}: ${detail.slice(0, 400)}${hint}`);
  }

  // Successful response shape: { ok: true, traceId }
  return {
    ok: true,
    raw: res.data,
    traceId: res.data?.traceId || null,
  };
}

/**
 * Optional propagation delay — gives the cloned funnel a few seconds to be
 * visible through the funnels-list API before subsequent steps (e.g. the
 * customValues push) try to use it.
 */
export function waitForCloneVisibility(ms = 4000) {
  return new Promise(resolve => setTimeout(resolve, ms));
}