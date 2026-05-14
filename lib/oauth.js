// lib/oauth.js — GoHighLevel OAuth 2.0 helpers (Sub-Account flow).
//
// Flow summary:
//   1. Sub-account user clicks Install → buildAuthorizeUrl() → redirect to GHL.
//   2. GHL bounces back to /oauth/callback with ?code=... → exchangeCodeForToken().
//   3. We persist the sub-account access + refresh tokens, keyed by locationId.
//   4. When pushing to that sub-account: getValidTokenForLocation() returns the
//      stored token (refreshing first if expired).
//
// Token lifetimes (per HighLevel docs):
//   - Access token: ~24 hours
//   - Refresh token: 1 year, single-use (a fresh one is returned on every refresh)
//
import axios from 'axios';
import crypto from 'crypto';

const OAUTH_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';
const MARKETPLACE_AUTHORIZE = 'https://marketplace.gohighlevel.com/oauth/chooselocation';

// ---------------------------------------------------------------------
// State (CSRF) cache for in-flight authorize requests.
// Lives in-memory; small TTL. Survives if process stays up across the OAuth dance.
// ---------------------------------------------------------------------
const stateCache = new Map(); // state -> { createdAt, returnTo }
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function newState(returnTo = '/') {
  const state = crypto.randomBytes(16).toString('hex');
  stateCache.set(state, { createdAt: Date.now(), returnTo });
  // Opportunistic cleanup
  for (const [k, v] of stateCache.entries()) {
    if (Date.now() - v.createdAt > STATE_TTL_MS) stateCache.delete(k);
  }
  return state;
}

export function consumeState(state) {
  const v = stateCache.get(state);
  if (!v) return null;
  stateCache.delete(state);
  if (Date.now() - v.createdAt > STATE_TTL_MS) return null;
  return v;
}

// ---------------------------------------------------------------------
// Step 1: Build the URL we redirect users to so they can install/authorize
// ---------------------------------------------------------------------
export function buildAuthorizeUrl({ clientId, redirectUri, scopes, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: redirectUri,
    client_id: clientId,
    scope: Array.isArray(scopes) ? scopes.join(' ') : scopes,
    state,
  });
  return `${MARKETPLACE_AUTHORIZE}?${params.toString()}`;
}

// ---------------------------------------------------------------------
// Step 2: Exchange the ?code we get on /oauth/callback for an access+refresh pair
// userType = 'Location' for Sub-Account-targeted apps (the flow we use here)
// ---------------------------------------------------------------------
export async function exchangeCodeForToken({ code, clientId, clientSecret, redirectUri, userType = 'Location' }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    user_type: userType,
  });
  if (redirectUri) body.set('redirect_uri', redirectUri);
  try {
    const { data } = await axios.post(OAUTH_TOKEN_URL, body.toString(), {
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });
    return data;
    // Expected fields: access_token, refresh_token, expires_in, scope, locationId, companyId, userType
  } catch (e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    throw new Error(`OAuth token exchange failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------
// Refresh an expired sub-account token
// ---------------------------------------------------------------------
export async function refreshAccessToken({ refreshToken, clientId, clientSecret, userType = 'Location' }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    user_type: userType,
  });
  try {
    const { data } = await axios.post(OAUTH_TOKEN_URL, body.toString(), {
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });
    return data;
  } catch (e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    throw new Error(`OAuth token refresh failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------
// Mint a Location-scoped access token from a Company-level OAuth install.
// Used when the app was installed at agency level (userType=Company) and we
// need to operate on a specific sub-account.
// Docs: https://highlevel.stoplight.io/docs/integrations/00d0c0ecaa369-get-location-access-token-from-agency-token
// ---------------------------------------------------------------------
export async function mintLocationToken({ companyAccessToken, companyId, locationId }) {
  const body = new URLSearchParams({ companyId, locationId });
  try {
    const { data } = await axios.post(
      'https://services.leadconnectorhq.com/oauth/locationToken',
      body.toString(),
      {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${companyAccessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Version': '2021-07-28',
        },
        timeout: 30000,
      }
    );
    return data;
    // Expected fields: access_token, scope, locationId, token_type, expires_in, userType
  } catch (e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    throw new Error(`Location token mint failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------
// High-level: get a valid access token for a specific location.
// Handles auto-refresh. Returns a string (the access token) suitable for use as Bearer.
// ---------------------------------------------------------------------
export async function getValidTokenForLocation({ store, clientId, clientSecret, locationId }) {
  const install = await store.getInstallation(locationId);
  if (!install) {
    throw new Error(`Location ${locationId} has not installed the app yet. Visit /setup to install.`);
  }
  const now = Date.now();

  // Serve the stored token if it's still valid (60s buffer)
  if (install.expiresAt && install.expiresAt > now + 60_000) {
    return install.accessToken;
  }

  // Token expired (or about to) — refresh it
  console.log(`🔄 Refreshing token for location ${locationId}...`);
  const r = await refreshAccessToken({
    refreshToken: install.refreshToken,
    clientId, clientSecret,
    userType: 'Location',
  });
  const updated = await store.saveInstallation({
    locationId,
    companyId: install.companyId,
    accessToken: r.access_token,
    refreshToken: r.refresh_token || install.refreshToken,
    expiresAt: now + ((r.expires_in || 86400) * 1000),
    scopes: r.scope || install.scopes,
  });
  return updated.accessToken;
}