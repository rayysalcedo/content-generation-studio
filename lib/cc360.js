// lib/cc360.js — Push a course draft to CC360 + attach thumbnails to proper fields.
//
// Two-phase push:
//   1. importCourse() → POST to the public courses-exporter endpoint to create the
//      course skeleton (modules, lessons, HTML bodies, workbook download links).
//   2. attachThumbnails() → use CC360's internal backend API to set posterImage on
//      the course (Settings → Course Thumbnail) and each lesson (right sidebar →
//      Lesson Thumbnail). These fields live on a different endpoint than the import.
//
import axios from 'axios';
import { renderLessonHTML, buildTheme } from './render-html.js';

// =====================================================================
// Public Import API (services.leadconnectorhq.com)
// =====================================================================

/**
 * Build the import payload. Tries to include posterImage directly on products + posts so
 * the import endpoint attaches thumbnails during course creation. If CC360 honors these
 * fields, we don't need the separate attachThumbnails phase at all.
 *
 * If the import endpoint silently ignores posterImage, attachThumbnails() can be run as a
 * fallback (requires CC360_USER_JWT for backend.* auth).
 */
export function buildImportPayload({
  locationId, draft, accent,
  workbookUrlByLessonKey = {},
  courseThumbnailUrl = null,                    // NEW: course-level poster
  thumbnailUrlByLessonKey = {},                 // NEW: per-lesson poster
}) {
  const theme = buildTheme(accent);
  return {
    locationId,
    products: [
      {
        title: draft.courseTitle,
        description: draft.courseDescription || `Course built on ${new Date().toLocaleDateString()}`,
        ...(courseThumbnailUrl ? { posterImage: courseThumbnailUrl } : {}),
        categories: (draft.modules || []).map((mod, mi) => ({
          title: mod.title,
          description: mod.description || '',
          posts: (mod.lessons || []).map((lesson, li) => {
            const key = `m${mi}-l${li}`;
            const workbookUrl = workbookUrlByLessonKey[key];
            const lessonThumb = thumbnailUrlByLessonKey[key];
            return {
              title: lesson.title,
              description: renderLessonHTML(lesson, theme, { workbookUrl }),
              contentType: 'video',
              ...(lessonThumb ? { posterImage: lessonThumb } : {}),
            };
          }),
        })),
      },
    ],
  };
}

export async function importCourse({
  pit, locationId, draft, accent,
  workbookUrlByLessonKey,
  courseThumbnailUrl,                           // NEW
  thumbnailUrlByLessonKey,                      // NEW
}) {
  const payload = buildImportPayload({
    locationId, draft, accent,
    workbookUrlByLessonKey,
    courseThumbnailUrl,
    thumbnailUrlByLessonKey,
  });
  const res = await axios.post(
    'https://services.leadconnectorhq.com/courses/courses-exporter/public/import',
    payload,
    {
      headers: {
        'accept': 'application/json',
        'authorization': `Bearer ${pit}`,
        'content-type': 'application/json',
        'version': '2021-07-28',
      },
      timeout: 120000,
    }
  );
  const course = res.data.processingCourses?.[0];
  if (!course) throw new Error(`Unexpected response: ${JSON.stringify(res.data)}`);
  return { ...course, message: res.data.message, note: res.data.note };
}

// =====================================================================
// Internal Backend API (backend.leadconnectorhq.com)
// Confirmed working: CC360 web UI calls this host with User-authClass JWT.
// Server-side calls work too as long as we send the same fingerprint headers
// (origin/referer/sec-* in backendHeaders below).
// Used to attach thumbnails to the proper Lesson Thumbnail / Course Thumbnail
// sidebar fields after import. Field name: `posterImage`.
// =====================================================================

function backendHeaders(token, locationId, tokenId) {
  const h = {
    // Standard request headers
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
    'priority': 'u=1, i',
    // GHL app-specific headers (validated by backend)
    'channel': 'APP',
    'source': 'WEB_USER',
    'sourceid': locationId,
    // Origin/referer for CSRF check
    'origin': 'https://app.coursecreator360.com',
    'referer': 'https://app.coursecreator360.com/',
    // Browser fingerprint headers — GHL's WAF likely checks for sec-fetch-*
    // to ensure the request originated from a real cross-origin browser fetch.
    'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  };
  // Firebase ID token — only present on some endpoints (notifications, prospecting).
  // Membership/clientclub endpoints don't seem to need it but it's harmless to include.
  if (tokenId) h['token-id'] = tokenId;
  return h;
}

/**
 * Fetch the course's category + post structure (modules + lessons with IDs).
 * We need the actual postIds to attach thumbnails — they're assigned by CC360
 * after import, not by us.
 */
export async function fetchCourseStructure({ token, tokenId, locationId, productId }) {
  const url = `https://backend.leadconnectorhq.com/membership/locations/${encodeURIComponent(locationId)}/categories?product_id=${encodeURIComponent(productId)}&posts=true`;
  const { data } = await axios.get(url, {
    headers: backendHeaders(token, locationId, tokenId),
    timeout: 30000,
  });
  return data;
}

/**
 * Update the course's posterImage field (visible in Course Settings).
 */
export async function updateCourseThumbnail({ token, tokenId, locationId, productId, posterImageUrl, title, description }) {
  const url = `https://backend.leadconnectorhq.com/membership/locations/${encodeURIComponent(locationId)}/products/${encodeURIComponent(productId)}`;
  const body = { posterImage: posterImageUrl };
  if (title) body.title = title;
  if (description) body.description = description;
  const { data } = await axios.put(url, body, {
    headers: backendHeaders(token, locationId, tokenId),
    timeout: 30000,
  });
  return data;
}

/**
 * Update a single lesson's posterImage field (Lesson Thumbnail in the right sidebar).
 *
 * IMPORTANT: this endpoint is a FULL REPLACE PUT — the web UI sends the entire
 * lesson state on save. We mirror that to avoid wiping title/description/etc.
 * Caller must pass the existing `post` object from fetchCourseStructure().
 */
export async function updateLessonThumbnail({ token, tokenId, locationId, post, posterImageUrl }) {
  if (!post?.id) throw new Error('updateLessonThumbnail requires a post object with an id');
  const url = `https://backend.leadconnectorhq.com/membership/locations/${encodeURIComponent(locationId)}/posts/${encodeURIComponent(post.id)}`;

  // Mirror the field list the CC360 web UI sends. Defaults fill in anything missing
  // from the GET (e.g. visibility flags on a freshly-imported lesson).
  const body = {
    categoryId: post.categoryId,
    productId: post.productId,
    title: post.title,
    description: post.description,
    sequenceNo: post.sequenceNo,
    posterImage: posterImageUrl,                                          // ← the new value
    commentStatus: post.commentStatus ?? 'visible',
    contentType: post.contentType ?? 'video',
    commentPermission: post.commentPermission ?? 'enabled',
    lockedByPost: post.lockedByPost ?? null,
    lockedByCategory: post.lockedByCategory ?? null,
    certificateTemplateId: post.certificateTemplateId ?? null,
    visibility: post.visibility ?? 'published',
    metaData: post.metaData ?? { embedMediaId: null },
    originId: post.originId ?? null,
    userId: post.userId,
  };

  const { data } = await axios.put(url, body, {
    headers: backendHeaders(token, locationId, tokenId),
    timeout: 30000,
  });
  return data;
}

/**
 * High-level: poll for the imported course to be ready, then attach the course
 * thumbnail + every lesson thumbnail to the proper sidebar fields.
 *
 * @param {Object} opts
 * @param {string} opts.token - Bearer (OAuth-minted location token or PIT)
 * @param {string} opts.locationId
 * @param {string} opts.productId - the id returned by importCourse
 * @param {string} opts.courseTitle
 * @param {string} opts.courseDescription
 * @param {string|null} opts.courseThumbnailUrl - media library URL, or null to skip
 * @param {Object<string,string>} opts.lessonThumbnailMap - { "m0-l0": url, ... }
 * @param {Function} [opts.onProgress] - ({ phase, ... }) => void
 * @returns {Promise<{ course: {ok,error?,url?}|null, lessons: Array }>}
 */
export async function attachThumbnails({
  token, backendToken, backendTokenId,           // backendToken: User JWT; backendTokenId: Firebase token-id header
  locationId, productId,
  courseTitle, courseDescription,
  courseThumbnailUrl, lessonThumbnailMap = {},
  maxWaitMs = 60_000, pollIntervalMs = 2_000,
  onProgress = () => {},
}) {
  const effectiveToken = backendToken || token;         // backend.* prefers user JWT if provided
  const effectiveTokenId = backendTokenId || null;      // Firebase ID token, required for backend.*
  const results = { course: null, lessons: [], authSource: backendToken ? 'user-jwt' : 'inherited' };
  const expectedLessonKeys = Object.keys(lessonThumbnailMap || {});
  const wantsCourseThumb = !!courseThumbnailUrl;
  const wantsAnyLessonThumb = expectedLessonKeys.length > 0;

  // ---- 1. Poll for the course to be fully created (lessons must exist) ----
  // Fast-fail: if the very first response is 401/403, no amount of waiting will help.
  let structure = null;
  let lastPollError = null;
  let authRejected = false;
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const data = await fetchCourseStructure({ token: effectiveToken, tokenId: effectiveTokenId, locationId, productId });
      const categories = data?.categories || [];
      const totalPosts = categories.reduce((n, c) => n + (c.posts?.length || 0), 0);
      if (totalPosts >= expectedLessonKeys.length) {
        structure = data;
        break;
      }
      onProgress({ phase: 'polling', totalPosts, expected: expectedLessonKeys.length });
    } catch (e) {
      const status = e.response?.status;
      lastPollError = status
        ? `HTTP ${status} ${e.response.statusText || ''} — ${typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data)}`
        : e.message;
      onProgress({ phase: 'polling-retry', error: lastPollError });
      // Fast-fail on auth rejection — retrying won't change the answer
      if (status === 401 || status === 403) {
        authRejected = true;
        break;
      }
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  if (!structure && (wantsCourseThumb || wantsAnyLessonThumb)) {
    throw new Error(
      authRejected
        ? `backend.leadconnectorhq.com rejected auth: ${lastPollError}`
        : `Course structure did not appear within ${maxWaitMs / 1000}s. ${lastPollError ? `Last error: ${lastPollError}` : 'No error captured.'}`
    );
  }

  // ---- 2. Update course poster (Course Thumbnail field) ----
  if (wantsCourseThumb) {
    try {
      await updateCourseThumbnail({
        token: effectiveToken, tokenId: effectiveTokenId, locationId, productId,
        posterImageUrl: courseThumbnailUrl,
        title: courseTitle,
        description: courseDescription,
      });
      results.course = { ok: true, url: courseThumbnailUrl };
      onProgress({ phase: 'course-attached' });
    } catch (e) {
      results.course = { ok: false, error: e.response?.data || e.message };
      onProgress({ phase: 'course-failed', error: results.course.error });
    }
  }

  // ---- 3. Update each lesson poster (Lesson Thumbnail field) in parallel ----
  if (wantsAnyLessonThumb && structure) {
    const categories = structure.categories || [];
    const tasks = expectedLessonKeys.map(async (key) => {
      const m = parseInt(key.match(/m(\d+)/)?.[1], 10);
      const l = parseInt(key.match(/l(\d+)/)?.[1], 10);
      const category = categories[m];
      const post = category?.posts?.[l];
      if (!post?.id) {
        return { key, ok: false, error: `lesson m${m}-l${l} not found in fetched structure` };
      }
      try {
        await updateLessonThumbnail({
          token: effectiveToken, tokenId: effectiveTokenId, locationId,
          post,                              // full existing post — preserves title/description/etc.
          posterImageUrl: lessonThumbnailMap[key],
        });
        return { key, postId: post.id, ok: true, url: lessonThumbnailMap[key] };
      } catch (e) {
        return { key, postId: post.id, ok: false, error: e.response?.data || e.message };
      }
    });
    results.lessons = await Promise.all(tasks);
    onProgress({
      phase: 'lessons-done',
      total: results.lessons.length,
      ok: results.lessons.filter(r => r.ok).length,
    });
  }

  return results;
}