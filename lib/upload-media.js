// lib/upload-media.js — Upload files to the platform's media systems.
//
// Two upload paths:
//   1. uploadToMediaLibrary()  → general media library at services.leadconnectorhq.com/medias/upload-file
//                               (PDFs, anything that just needs a public URL)
//   2. uploadCourseMedia()     → courses-specific CDN at cdn.courses.apisystem.tech
//                               (REQUIRED for course/lesson posterImage)
//
// Why two paths? The /courses/courses-exporter/public/import endpoint silently drops
// posterImage URLs that aren't on cdn.courses.apisystem.tech. The general media library
// lives on a different CDN, so anything uploaded there gets ignored when used as a
// posterImage. Course thumbnails must go through the signed-URL flow below.
//
import axios from 'axios';
import FormData from 'form-data';

const PUBLIC_API = 'https://services.leadconnectorhq.com';

// ---------------------------------------------------------------------
// 1) General media library — used for workbook PDFs.
//    Returns the public URL of the uploaded asset.
// ---------------------------------------------------------------------
export async function uploadToMediaLibrary({ pit, locationId, buffer, filename, contentType = 'application/pdf' }) {
  const form = new FormData();
  form.append('file', buffer, { filename, contentType });
  form.append('locationId', locationId);
  form.append('name', filename);

  const res = await axios.post(`${PUBLIC_API}/medias/upload-file`, form, {
    headers: {
      ...form.getHeaders(),
      'authorization': `Bearer ${pit}`,
      'version': '2021-07-28',
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120000,
  });

  const data = res.data || {};
  const fileId = data.fileId || data.id || data._id;
  const url = data.url || data.fileUrl || data.publicUrl;
  if (!url) {
    throw new Error(`media upload succeeded but URL not found in response. Keys: ${Object.keys(data).join(', ')}`);
  }
  return { fileId, url };
}

// ---------------------------------------------------------------------
// 2) Courses CDN — REQUIRED for posterImage attachment.
//
// Two-step signed-URL flow:
//   a. POST /membership/locations/{lid}/media/signed-url
//      body: { filename, folder, type }
//      → returns { signedUrl, publicUrl, ... }   (exact key names TBC — handler below
//                                                  tolerates several aliases and logs
//                                                  the raw shape on first miss)
//   b. PUT bytes to signedUrl with the matching Content-Type
//   c. publicUrl is what goes into posterImage on products/posts in the import payload
// ---------------------------------------------------------------------
/**
 * Upload an image to the courses CDN (cdn.courses.apisystem.tech) for use as a course
 * or lesson posterImage.
 *
 * @param {Object} opts
 * @param {string} opts.token        - OAuth Bearer token for the location
 * @param {string} opts.locationId   - Sub-account location ID
 * @param {Buffer} opts.buffer       - Image bytes
 * @param {string} [opts.filename]   - Basename (no extension); auto-generated if omitted
 * @param {string} [opts.folder]     - 'product' for course-level (default); try 'post' for lessons if needed
 * @param {string} [opts.mimeType]   - 'image/png' by default
 * @returns {Promise<{ publicUrl: string, signedUrl: string, raw: Object }>}
 */
export async function uploadCourseMedia({
  token,
  tokenId,             // Optional Firebase ID token — included as `token-id` header when present
  locationId,
  buffer,
  filename,
  folder = 'product',
  mimeType = 'image/png',
}) {
  if (!token)      throw new Error('uploadCourseMedia requires a Bearer token');
  if (!locationId) throw new Error('uploadCourseMedia requires locationId');
  if (!buffer || !buffer.length) throw new Error('uploadCourseMedia requires non-empty buffer');

  // GHL preserves the filename we send (plus a short random suffix) when building the
  // public URL. Course import validates that posterImage URLs end in a real image
  // extension, so we MUST include one here — otherwise the URL gets silently dropped
  // from the import payload.
  const extFromMime = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/webp': 'webp', 'image/gif': 'gif',
  }[mimeType.toLowerCase()] || 'png';
  const baseName = filename || `thumb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const id = baseName.toLowerCase().endsWith(`.${extFromMime}`) ? baseName : `${baseName}.${extFromMime}`;

  // ---- Step 1: get a signed PUT URL ----
  // NOTE: this endpoint only accepts User-authClass JWTs (the ones the GoHighLevel web app
  // uses). OAuth Location/Company-minted tokens get HTTP 401 here.
  const signedHeaders = {
    'authorization': `Bearer ${token}`,
    'channel': 'APP',
    'source': 'WEB_USER',
    'sourceid': locationId,
    'content-type': 'application/json',
    'accept': 'application/json, text/plain, */*',
    'version': '2021-07-28',
  };
  if (tokenId) signedHeaders['token-id'] = tokenId;

  let signedRes;
  try {
    signedRes = await axios.post(
      `${PUBLIC_API}/membership/locations/${encodeURIComponent(locationId)}/media/signed-url`,
      { filename: id, folder, type: mimeType },
      { headers: signedHeaders, timeout: 30000 }
    );
  } catch (e) {
    const status = e.response?.status;
    const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : e.message;
    throw new Error(`signed-url request failed (HTTP ${status || '?'}): ${body}`);
  }

  const raw = signedRes.data || {};

  // GHL's response field names aren't perfectly documented for this endpoint.
  // Confirmed shape (from network trace): { error, url, unsignedUrl }
  //   - `url`        : the signed PUT URL (with GoogleAccessId+Signature query string)
  //   - `unsignedUrl`: the public URL minus the signature — but on storage.googleapis.com
  // The import endpoint wants the same path served by cdn.courses.apisystem.tech, so we
  // transform the hostname below. Other field-name candidates are kept as defensive
  // fallbacks in case GHL changes the response shape.
  const signedUrl =
    raw.signedUrl ||
    raw.uploadUrl ||
    raw.putUrl ||
    raw.url;
  let publicUrl =
    raw.publicUrl ||
    raw.fileUrl ||
    raw.cdnUrl ||
    raw.assetUrl ||
    raw.unsignedUrl ||
    (raw.path ? `https://cdn.courses.apisystem.tech${raw.path.startsWith('/') ? '' : '/'}${raw.path}` : null);

  // Hostname swap: GCS bucket URL → public CDN URL
  // e.g. https://storage.googleapis.com/revex-membership-production/memberships/{lid}/product/{file}
  //   →  https://cdn.courses.apisystem.tech/memberships/{lid}/product/{file}
  if (publicUrl && /^https:\/\/storage\.googleapis\.com\/revex-membership-production\//i.test(publicUrl)) {
    publicUrl = publicUrl.replace(
      /^https:\/\/storage\.googleapis\.com\/revex-membership-production/i,
      'https://cdn.courses.apisystem.tech'
    );
  }

  if (!signedUrl || !publicUrl) {
    // Print so we can adjust extraction if needed.
    console.error('[uploadCourseMedia] unexpected signed-url response shape:',
      JSON.stringify(raw, null, 2));
    throw new Error(
      `signed-url response missing ${!signedUrl ? 'upload' : 'public'} URL. ` +
      `Keys returned: ${Object.keys(raw).join(', ') || '(none)'}`
    );
  }

  // ---- Step 2: PUT the bytes to GCS ----
  try {
    await axios.put(signedUrl, buffer, {
      headers: { 'content-type': mimeType },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120000,
      // The signed URL carries its own auth via the GoogleAccessId+Signature
      // query string. Do NOT add our Bearer here or GCS will reject it.
      transformRequest: [(d) => d],
    });
  } catch (e) {
    const status = e.response?.status;
    const body = e.response?.data ? String(e.response.data).slice(0, 500) : e.message;
    throw new Error(`signed PUT to GCS failed (HTTP ${status || '?'}): ${body}`);
  }

  return { publicUrl, signedUrl, raw };
}