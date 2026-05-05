// lib/upload-media.js — Upload a file (PDF, image, etc.) to the CC360 media library
// using the public, PIT-friendly endpoint.
//
// This is the SAME endpoint we proved works earlier:
//   POST https://services.leadconnectorhq.com/medias/upload-file
//   multipart/form-data: file, locationId, name
// Returns: { fileId, url } where url is the publicly-accessible asset URL.
//
import axios from 'axios';
import FormData from 'form-data';

const PUBLIC_API = 'https://services.leadconnectorhq.com';

/**
 * Upload a buffer to the CC360 media library.
 *
 * @param {Object} opts
 * @param {string} opts.pit          - Private Integration Token
 * @param {string} opts.locationId   - Sub-account location ID
 * @param {Buffer} opts.buffer       - File contents
 * @param {string} opts.filename     - File name (e.g. "lesson-01-workbook.pdf")
 * @param {string} [opts.contentType] - Defaults to "application/pdf"
 * @returns {Promise<{ fileId: string, url: string }>}
 */
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
  // Response shape varies — try common fields
  const fileId = data.fileId || data.id || data._id;
  const url = data.url || data.fileUrl || data.publicUrl;
  if (!url) {
    throw new Error(`media upload succeeded but URL not found in response. Keys: ${Object.keys(data).join(', ')}`);
  }
  return { fileId, url };
}
