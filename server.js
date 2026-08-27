// server.js — Content Generation Studio (web app)
//
// Run with:  node server.js
// Then open: http://localhost:3000
//
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { extractPdfText } from './lib/extract-pdf.js';
import { generateCourseStructure } from './lib/generate.js';
import { generateWorkbooksForCourse } from './lib/generate-workbook.js';
import { generateThumbnailsForCourse, base64ToBuffer } from './lib/generate-thumbnails.js';
import { renderLessonHTML, buildTheme } from './lib/render-html.js';
import { renderWorkbookPdf } from './lib/pdf-renderer.js';
import { uploadToMediaLibrary, uploadCourseMedia } from './lib/upload-media.js';
import { importCourse, attachThumbnails } from './lib/cc360.js';
import {
  buildAuthorizeUrl, exchangeCodeForToken, getValidTokenForLocation,
  newState, consumeState, mintLocationToken, refreshAccessToken,
} from './lib/oauth.js';
import { store as tokenStore, backendName as tokenStoreBackend } from './lib/token-store.js';
// --- Funnel tool: AI-generated 3-step funnel (sales / checkout / confirmation) ---
import { generateFunnelContent, flattenToCustomValueMap, nestedToFlatPreview, flatPreviewToNested } from './lib/generate-funnel.js';
import { generateFunnelImages } from './lib/generate-funnel-images.js';
import { pushCustomValues, uploadFunnelImages, uploadInstructorPhoto } from './lib/funnel-push.js';
import { cloneFunnelToLocations, waitForCloneVisibility } from './lib/funnel-share-push.js';
import { THEMES, DEFAULT_THEME, getTheme, isValidTheme } from './lib/funnel-themes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  CC360_JWT,                                  // Legacy PIT fallback (single-account use)
  CC360_USER_JWT,                             // User-session JWT for INTERNAL backend.* API (thumbnail attach only)
  CC360_LOCATION_ID,                          // Optional fallback (used by CLI / when form leaves it empty)
  GEMINI_API_KEY,                             // The one and only AI provider key now
  GEMINI_TEXT_MODEL = 'gemini-3.7-flash',     // Course structure + workbook + funnel copy
  GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image', // Thumbnails + funnel images (Nano Banana 2)
  GEMINI_IMAGE_SIZE = '1K',                   // '512' | '1K' | '2K' | '4K'
  AI_IMAGES = 'on',                           // 'off' → skip ALL image generation (free tier has no image models)
  GHL_CLIENT_ID,                              // OAuth: Sub-Account Marketplace App client ID
  GHL_CLIENT_SECRET,                          // OAuth: Sub-Account Marketplace App client secret
  GHL_OAUTH_REDIRECT_URI,                     // OAuth: e.g. https://your-app.onrender.com/oauth/callback
  GHL_OAUTH_SCOPES = 'medias.readonly medias.write courses.readonly courses.write locations.readonly snapshots.readonly snapshots.write',
  PORT = 3000,
  REGEN_LIMIT = 3,                            // max regenerations per sub-account
} = process.env;

// Default course size when user leaves the count fields empty (auto mode)
const DEFAULT_MODULE_COUNT = 5;
const DEFAULT_LESSONS_PER_MODULE = 5;

if (!GEMINI_API_KEY) {
  console.error('❌ Missing required env var: GEMINI_API_KEY');
  process.exit(1);
}
// Image generation is only possible on a paid Gemini project; on the free tier
// set AI_IMAGES=off so courses/funnels build without thumbnails instead of
// failing on every image call.
const IMAGES_ENABLED = !!GEMINI_API_KEY && String(AI_IMAGES).toLowerCase() !== 'off';
const oauthConfigured = !!(GHL_CLIENT_ID && GHL_CLIENT_SECRET && GHL_OAUTH_REDIRECT_URI);
if (!CC360_JWT && !oauthConfigured) {
  console.error('❌ No CC360 auth configured. Set either:');
  console.error('   • CC360_JWT (PIT, legacy single-account), OR');
  console.error('   • GHL_CLIENT_ID + GHL_CLIENT_SECRET + GHL_OAUTH_REDIRECT_URI (OAuth, multi-tenant)');
  process.exit(1);
}

// Validate a GHL location ID. Real IDs are ~20-char alphanumeric (e.g. ITeSh9QmCqRSsZwtBCZX).
// Keep this permissive — GHL has been known to issue 18-22 char IDs.
const LOCATION_ID_RE = /^[a-zA-Z0-9]{15,30}$/;
function isValidLocationId(s) {
  return typeof s === 'string' && LOCATION_ID_RE.test(s.trim());
}
function pickLocationId(reqValue) {
  const v = (reqValue || '').trim();
  if (v) return v;
  return CC360_LOCATION_ID || '';
}

// Resolve a CC360 auth token for a specific sub-account.
// Tries OAuth first (if configured); falls back to the legacy PIT.
// Returns a Bearer token string.
async function resolveTokenForLocation(locationId) {
  if (oauthConfigured) {
    // ---- Path 1: direct location install (sub-account-target OAuth or previously-minted) ----
    const direct = await tokenStore.getInstallation(locationId);
    if (direct) {
      const now = Date.now();
      // Token still valid
      if (direct.expiresAt && direct.expiresAt > now + 60_000) {
        return { token: direct.accessToken, source: direct.kind === 'location-minted' ? 'oauth-minted-cached' : 'oauth-location' };
      }
      // Expired — minted tokens get re-minted from the source company install
      if (direct.kind === 'location-minted' && direct.companyId) {
        const company = await tokenStore.getInstallation(`company:${direct.companyId}`);
        if (company) {
          try {
            const fresh = await mintAndSaveLocationToken(company, locationId);
            return { token: fresh, source: 'oauth-minted-refresh' };
          } catch (e) {
            console.warn(`⚠️  Re-mint failed for ${locationId} from company ${direct.companyId}: ${e.message}`);
          }
        }
      } else if (direct.refreshToken) {
        // Direct location install with refresh token — use existing refresh flow
        try {
          const token = await getValidTokenForLocation({
            store: tokenStore, clientId: GHL_CLIENT_ID, clientSecret: GHL_CLIENT_SECRET, locationId,
          });
          return { token, source: 'oauth-refresh' };
        } catch (e) {
          console.warn(`⚠️  Refresh failed for ${locationId}: ${e.message}`);
        }
      }
    }

    // ---- Path 2: no direct install — try minting from any company install we have ----
    const all = await tokenStore.listInstallations();
    const companies = all.filter(i => i.kind === 'company' && i.companyId);
    for (const company of companies) {
      try {
        const fresh = await mintAndSaveLocationToken(company, locationId);
        return { token: fresh, source: 'oauth-minted-fresh' };
      } catch (e) {
        console.warn(`⚠️  Mint from company ${company.companyId} for ${locationId} failed: ${e.message}`);
      }
    }

    // ---- Path 3: PIT fallback ----
    if (CC360_JWT) {
      console.warn(`⚠️  OAuth resolve failed for ${locationId} — falling back to PIT.`);
      return { token: CC360_JWT, source: 'pit-fallback' };
    }
    throw new Error(`Cannot authenticate to sub-account ${locationId}: no install (location or company) covers it, and no PIT fallback set.`);
  }
  if (CC360_JWT) return { token: CC360_JWT, source: 'pit' };
  throw new Error('No auth source available. Install the app at /setup, or set CC360_JWT.');
}

// Helper: mint a location token from a company install, refresh the company token first if it's about to expire, and cache the minted token so we don't re-mint on every request.
async function mintAndSaveLocationToken(companyInstall, locationId) {
  let companyAccessToken = companyInstall.accessToken;
  const now = Date.now();

  // Refresh the company token if it's about to expire (or already has)
  if (companyInstall.expiresAt && companyInstall.expiresAt < now + 60_000 && companyInstall.refreshToken) {
    console.log(`🔄 Refreshing company token for ${companyInstall.companyId}...`);
    const r = await refreshAccessToken({
      refreshToken: companyInstall.refreshToken,
      clientId: GHL_CLIENT_ID,
      clientSecret: GHL_CLIENT_SECRET,
      userType: 'Company',
    });
    companyAccessToken = r.access_token;
    await tokenStore.saveInstallation({
      locationId: `company:${companyInstall.companyId}`,
      companyId: companyInstall.companyId,
      accessToken: r.access_token,
      refreshToken: r.refresh_token || companyInstall.refreshToken,
      expiresAt: Date.now() + ((r.expires_in || 86400) * 1000),
      scopes: r.scope || companyInstall.scopes,
      kind: 'company',
    });
  }

  // Mint the location-scoped token
  const mint = await mintLocationToken({
    companyAccessToken,
    companyId: companyInstall.companyId,
    locationId,
  });

  // Cache it as a 'location-minted' install so future requests skip the mint round-trip
  await tokenStore.saveInstallation({
    locationId,
    companyId: companyInstall.companyId,
    accessToken: mint.access_token,
    refreshToken: null,                               // minted tokens can't refresh themselves; we re-mint when expired
    expiresAt: Date.now() + ((mint.expires_in || 86400) * 1000),
    scopes: mint.scope || companyInstall.scopes,
    installedAt: Date.now(),
    kind: 'location-minted',
  });

  console.log(`🎫 Minted location token for ${locationId} from company ${companyInstall.companyId}`);
  return mint.access_token;
}

// ---------------------------------------------------------------------
// Resolve an AGENCY (company) token usable for agency-scoped APIs
// like snapshots.{readonly,write}. Will pick the first company install
// that covers the target sub-account, refresh it if expired, and
// return its access token. Throws if no company install exists.
// ---------------------------------------------------------------------
async function resolveCompanyToken(locationId) {
  if (!oauthConfigured) {
    throw new Error('OAuth not configured — cannot get agency token (snapshot operations require OAuth).');
  }
  const all = await tokenStore.listInstallations();
  const companies = all.filter(i => i.kind === 'company' && i.companyId);
  if (companies.length === 0) {
    throw new Error('No agency install found. Install the OAuth app at agency level (Distribution Type: Agency) and grant snapshots.write.');
  }

  // Prefer the company that owns the target location if we can tell;
  // otherwise just use the first.
  let chosen = companies[0];
  if (locationId) {
    const direct = await tokenStore.getInstallation(locationId);
    if (direct?.companyId) {
      const match = companies.find(c => c.companyId === direct.companyId);
      if (match) chosen = match;
    }
  }

  // Refresh if needed
  const now = Date.now();
  if (chosen.expiresAt && chosen.expiresAt < now + 60_000 && chosen.refreshToken) {
    console.log(`🔄 Refreshing agency token for company ${chosen.companyId}...`);
    const r = await refreshAccessToken({
      refreshToken: chosen.refreshToken,
      clientId: GHL_CLIENT_ID,
      clientSecret: GHL_CLIENT_SECRET,
      userType: 'Company',
    });
    await tokenStore.saveInstallation({
      locationId: `company:${chosen.companyId}`,
      companyId: chosen.companyId,
      accessToken: r.access_token,
      refreshToken: r.refresh_token || chosen.refreshToken,
      expiresAt: Date.now() + ((r.expires_in || 86400) * 1000),
      scopes: r.scope || chosen.scopes,
      kind: 'company',
    });
    chosen = {
      ...chosen,
      accessToken: r.access_token,
      refreshToken: r.refresh_token || chosen.refreshToken,
      expiresAt: Date.now() + ((r.expires_in || 86400) * 1000),
      scopes: r.scope || chosen.scopes,
    };
  }

  return {
    accessToken: chosen.accessToken,
    companyId: chosen.companyId,
    scopes: chosen.scopes,
  };
}

// ---------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------
// Drafts are kept in memory for the life of the process. Restart = clean slate.
const drafts = new Map();   // draftId -> { input, structure, generatedAt, pushedAt? }

// Regen counts persist to disk so they survive restarts
const REGEN_FILE = path.join(__dirname, 'data', 'regen-counts.json');
function readRegenCounts() {
  try {
    if (!fs.existsSync(REGEN_FILE)) return {};
    return JSON.parse(fs.readFileSync(REGEN_FILE, 'utf8'));
  } catch (_) { return {}; }
}
function writeRegenCounts(obj) {
  try {
    fs.mkdirSync(path.dirname(REGEN_FILE), { recursive: true });
    fs.writeFileSync(REGEN_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('⚠️  Could not persist regen counts:', e.message); }
}
function getRegenInfo(locationId) {
  const counts = readRegenCounts();
  const used = counts[locationId] || 0;
  return { used, remaining: Math.max(0, Number(REGEN_LIMIT) - used), limit: Number(REGEN_LIMIT) };
}
function bumpRegen(locationId) {
  const counts = readRegenCounts();
  counts[locationId] = (counts[locationId] || 0) + 1;
  writeRegenCounts(counts);
  return getRegenInfo(locationId);
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// Slugify a title so we can use it in a filename
function slug(s, max = 60) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, max) || 'lesson';
}

// Resolve module/lesson counts: if user provided a value, use it; otherwise apply default
function resolveCount(provided, fallback) {
  const n = parseInt(provided, 10);
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
}

// Render a single lesson's workbook as a PDF buffer (using current draft data)
function renderLessonWorkbookPdf({ structure, accent, mi, li }) {
  const mod = structure.modules?.[mi];
  const lesson = mod?.lessons?.[li];
  if (!lesson) throw new Error(`Lesson m${mi}-l${li} not found`);

  // Compute lesson number across the whole course (1-indexed)
  let lessonNumber = 0;
  for (let i = 0; i <= mi; i++) {
    const lessons = structure.modules[i]?.lessons || [];
    if (i < mi) lessonNumber += lessons.length;
    else lessonNumber += li + 1;
  }

  return renderWorkbookPdf({
    courseTitle: structure.courseTitle || 'Course',
    lessonTitle: lesson.title,
    lessonNumber,
    summary: lesson.summary || '',
    questions: lesson.workbook?.questions || [],
    actionItems: lesson.workbook?.actionItems || [],
    reflection: lesson.workbook?.reflection || lesson.reflection || '',
    accent,
  });
}

// ---------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// File uploads land in uploads/ — multer manages temp storage
// Accept multiple named fields: pdf (course) and instructorPhoto (funnel)
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 25 * 1024 * 1024 },     // 25 MB cap for PDFs; photos are small
});

// ---------------------------------------------------------------------
// API: Generate a new draft
// ---------------------------------------------------------------------
app.post(
  '/api/generate',
  upload.fields([
    { name: 'pdf', maxCount: 1 },
    { name: 'instructorPhoto', maxCount: 1 },
  ]),
  async (req, res) => {
  // ── Streaming response: NDJSON events as generation proceeds, ending with
  //    a 'done' event containing the draftId. Same pattern as /api/push.
  //    Errors are emitted as { phase: 'error', error: ... } before res.end().
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const emit = (event) => { try { res.write(JSON.stringify(event) + '\n'); } catch {} };
  const fail = (errMsg, statusHint) => {
    emit({ phase: 'error', error: errMsg, statusHint: statusHint || null });
    res.end();
  };

  try {
    const { mode, courseTitle, targetAudience, instructions, description, moduleCount, lessonsPerModule, accent, generateWorkbooks } = req.body;
    // Funnel toggle + inputs (all optional; required only when generateFunnel === 'true')
    const generateFunnelFlag = req.body.generateFunnel === 'true' || req.body.generateFunnel === true;
    const { instructorName, coursePrice, brandDarkBg, funnelPitch } = req.body;
    const pdfFile = req.files?.pdf?.[0] || null;
    const photoFile = req.files?.instructorPhoto?.[0] || null;

    // Resolve & validate the target sub-account
    const locationId = pickLocationId(req.body.locationId);
    if (!locationId) {
      return fail('Sub-account Location ID is required');
    }
    if (!isValidLocationId(locationId)) {
      return fail('Sub-account Location ID looks malformed (expected ~20 alphanumeric characters)');
    }

    if (!mode || !courseTitle) {
      return fail('mode and courseTitle are required');
    }

    // Validate funnel inputs up-front (before doing expensive course gen)
    if (generateFunnelFlag) {
      if (!instructorName?.trim()) return fail('Funnel: Instructor name is required');
      if (!photoFile) return fail('Funnel: Instructor photo upload is required');
      if (!coursePrice?.trim()) return fail('Funnel: Course price is required');
      // brandDarkBg is no longer collected from the form — themes own all colors now.
      // Funnel seed: in description mode reuse description; in pdf mode require funnelPitch
      if (mode === 'pdf' && (!funnelPitch || funnelPitch.trim().length < 20)) {
        return fail('Funnel: Funnel Pitch is required (1-3 sentences) when course mode is PDF');
      }
    }

    let sourceText;
    if (mode === 'pdf') {
      if (!pdfFile) return fail('PDF file is required for PDF mode');
      const { text } = await extractPdfText(pdfFile.path);
      sourceText = text;
      try { fs.unlinkSync(pdfFile.path); } catch (_) {}
      if (sourceText.length < 50) {
        return fail('PDF text is too short. Is it scanned/image-based? OCR not supported.');
      }
    } else if (mode === 'description') {
      if (!description || description.trim().length < 20) {
        return fail('Course description must be at least 20 characters');
      }
      sourceText = description.trim();
    } else {
      return fail(`Unknown mode: ${mode}`);
    }

    // Announce that we're getting started
    emit({ phase: 'start', hasFunnel: generateFunnelFlag, hasWorkbooks: generateWorkbooks !== 'false' && generateWorkbooks !== false, hasThumbnails: req.body.generateThumbnails !== 'false' && req.body.generateThumbnails !== false });

    // Resolve course size — apply defaults when user left fields empty
    const resolvedModuleCount = resolveCount(moduleCount, DEFAULT_MODULE_COUNT);
    const resolvedLessonsPerModule = resolveCount(lessonsPerModule, DEFAULT_LESSONS_PER_MODULE);

    // 1. Generate course structure (existing)
    console.log(`📚 Generating course structure for "${courseTitle}" (${resolvedModuleCount} × ${resolvedLessonsPerModule})...`);
    emit({ phase: 'outline', status: 'start' });
    const structure = await generateCourseStructure({
      apiKey: GEMINI_API_KEY,
      model: GEMINI_TEXT_MODEL,
      mode,
      sourceText,
      courseTitle,
      targetAudience: targetAudience || 'general learners',
      instructions: instructions || '',
      moduleCount: resolvedModuleCount,
      lessonsPerModule: resolvedLessonsPerModule,
    });
    structure.courseTitle = courseTitle;

    const totalLessons = (structure.modules || []).reduce((n, m) => n + (m.lessons?.length || 0), 0);
    console.log(`   ✓ ${structure.modules?.length || 0} modules, ${totalLessons} lessons`);
    emit({ phase: 'outline', status: 'done', moduleCount: structure.modules?.length || 0, lessonCount: totalLessons });

    // 2-4. Kick off three INDEPENDENT chains in parallel — each only depends on
    // `structure` (or in the funnel-image case, on the funnel-content output of
    // its own chain). Promise.allSettled means a failure in one chain doesn't
    // sabotage the others, mirroring the original sequential error-handling.
    //
    // Old sequential timing (typical 25-lesson course, with BATCH_SIZE=1 image gen):
    //   outline → workbooks (~3m) → thumbnails (~5.6m) → funnel (~3.5m) ≈ 13 min total
    // New parallel + bumped concurrency:
    //   outline → max(workbooks~1.5m, thumbnails~1m, funnel~2m) ≈ 3-4 min total
    const wantWorkbooks  = generateWorkbooks !== 'false' && generateWorkbooks !== false;
    const wantThumbnails = req.body.generateThumbnails !== 'false' && req.body.generateThumbnails !== false;
    console.log(`⚡ Starting parallel generation: workbooks=${wantWorkbooks}, thumbnails=${wantThumbnails}, funnel=${generateFunnelFlag}`);
    const tParallel = Date.now();

    // ── Chain 1: Workbooks (depends on `structure` only) ────────────────
    const workbookChain = (async () => {
      if (!(wantWorkbooks && totalLessons > 0)) {
        return { skipped: true, stats: { total: 0, failed: 0 } };
      }
      console.log(`📝 [parallel] Generating workbook content for ${totalLessons} lessons...`);
      emit({ phase: 'workbooks', status: 'start', total: totalLessons });
      const r = await generateWorkbooksForCourse({
        apiKey: GEMINI_API_KEY,
        model: GEMINI_TEXT_MODEL,
        structure,
        onProgress: ({ done, total, failed }) => {
          if (done % 5 === 0 || done === total) {
            console.log(`   📝 ...${done}/${total} workbooks${failed ? ` (${failed} failed)` : ''}`);
          }
          emit({ phase: 'workbooks', status: 'progress', done, total, failed });
        },
      });
      console.log(`   ✓ Workbooks: ${r.total - r.failed}/${r.total} succeeded`);
      emit({ phase: 'workbooks', status: 'done', total: r.total, failed: r.failed });
      return { skipped: false, stats: { total: r.total, failed: r.failed } };
    })();

    // ── Chain 2: Thumbnails (depends on `structure` only) ───────────────
    const thumbnailChain = (async () => {
      if (!(wantThumbnails && totalLessons > 0)) {
        return { skipped: true, stats: { total: 0, failed: 0 }, thumbnails: {} };
      }
      if (!IMAGES_ENABLED) {
        return { skipped: true, stats: { total: totalLessons + 1, failed: totalLessons + 1, error: 'Image generation disabled (AI_IMAGES=off or no key)' }, thumbnails: {} };
      }
      console.log(`🎨 [parallel] Generating ${totalLessons + 1} AI thumbnails (${GEMINI_IMAGE_MODEL}, ${GEMINI_IMAGE_SIZE})...`);
      emit({ phase: 'thumbnails', status: 'start', total: totalLessons + 1 });
      try {
        const r = await generateThumbnailsForCourse({
          apiKey: GEMINI_API_KEY,
          model: GEMINI_IMAGE_MODEL,
          imageSize: GEMINI_IMAGE_SIZE,
          structure,
          accent: accent || '#6366f1',
          targetAudience: targetAudience || '',
          onProgress: ({ done, total, failed, label }) => {
            if (done % 5 === 0 || done === total) {
              console.log(`   🎨 ...${done}/${total} thumbnails${failed ? ` (${failed} failed)` : ''} — last: ${label}`);
            }
            emit({ phase: 'thumbnails', status: 'progress', done, total, failed, label });
          },
        });
        console.log(`   ✓ Thumbnails: ${r.total - r.failed}/${r.total} succeeded`);
        emit({ phase: 'thumbnails', status: 'done', total: r.total, failed: r.failed });
        return { skipped: false, stats: { total: r.total, failed: r.failed }, thumbnails: r.thumbnails };
      } catch (e) {
        console.warn(`⚠️  Thumbnail generation block failed: ${e.message}. Continuing without thumbnails.`);
        emit({ phase: 'thumbnails', status: 'failed', error: e.message });
        return { skipped: true, stats: { total: totalLessons + 1, failed: totalLessons + 1, error: e.message }, thumbnails: {} };
      }
    })();

    // ── Chain 3: Funnel content → Funnel images (chained inside, but the
    // whole chain runs alongside chains 1 + 2) ──────────────────────────
    const funnelChain = (async () => {
      if (!generateFunnelFlag) {
        return { skipped: true, funnelContent: null, funnelImages: {}, funnelImageStats: { total: 0, failed: 0 }, instructorPhotoBlob: null };
      }
      const funnelSeed = mode === 'description'
        ? description.trim()
        : (funnelPitch || '').trim();
      const brandPrimary = accent || '#6366f1';
      try {
        console.log(`📝 [parallel] Generating funnel copy for "${courseTitle}"...`);
        emit({ phase: 'funnel-content', status: 'start' });
        const funnelContent = await generateFunnelContent({
          apiKey: GEMINI_API_KEY,
          model: GEMINI_TEXT_MODEL,
          courseTitle,
          courseDescription: funnelSeed,
          instructorName: instructorName.trim(),
          coursePrice: coursePrice.trim(),
          brandPrimary,
          instructions: instructions || '',
        });
        console.log(`   ✓ Funnel copy generated`);
        emit({ phase: 'funnel-content', status: 'done' });

        let funnelImages = {};
        let funnelImageStats = { total: 0, failed: 0 };
        if (IMAGES_ENABLED) {
          console.log(`🎨 [parallel] Generating funnel images (${GEMINI_IMAGE_MODEL}, ${GEMINI_IMAGE_SIZE})...`);
          emit({ phase: 'funnel-images', status: 'start' });
          try {
            const r = await generateFunnelImages({
              apiKey: GEMINI_API_KEY,
              model: GEMINI_IMAGE_MODEL,
              imageSize: GEMINI_IMAGE_SIZE,
              content: funnelContent,
              courseTitle,
              accent: brandPrimary,
              onProgress: ({ done, total, label }) => {
                if (done === 1 || done % 3 === 0 || done === total) {
                  console.log(`   🎨 ...${done}/${total} funnel imgs — last: ${label}`);
                }
                emit({ phase: 'funnel-images', status: 'progress', done, total, label });
              },
            });
            funnelImages = r.images;
            funnelImageStats = { total: r.total, failed: r.failed };
            console.log(`   ✓ Funnel images: ${r.total - r.failed}/${r.total} succeeded`);
            emit({ phase: 'funnel-images', status: 'done', total: r.total, failed: r.failed });
          } catch (e) {
            console.warn(`⚠️  Funnel image generation failed: ${e.message}. Continuing without images.`);
            emit({ phase: 'funnel-images', status: 'failed', error: e.message });
            funnelImageStats = { total: 9, failed: 9, error: e.message };
          }
        }

        const instructorPhotoBlob = {
          buffer: fs.readFileSync(photoFile.path),
          mime: photoFile.mimetype || 'image/jpeg',
          filename: photoFile.originalname || `instructor-${Date.now()}.jpg`,
        };
        try { fs.unlinkSync(photoFile.path); } catch (_) {}

        return { skipped: false, funnelContent, funnelImages, funnelImageStats, instructorPhotoBlob };
      } catch (err) {
        console.warn(`⚠️  Funnel chain failed: ${err.message}`);
        return { skipped: true, funnelContent: null, funnelImages: {}, funnelImageStats: { total: 0, failed: 0, error: err.message }, instructorPhotoBlob: null };
      }
    })();

    // Wait for all three chains. allSettled never throws — each chain returns a
    // descriptive object (and itself catches its inner errors), so we can pull
    // the results out positionally without re-checking status.
    const [workbookSettled, thumbnailSettled, funnelSettled] = await Promise.allSettled([
      workbookChain, thumbnailChain, funnelChain,
    ]);
    const wbR = workbookSettled.status === 'fulfilled' ? workbookSettled.value : { stats: { total: 0, failed: 0, error: workbookSettled.reason?.message } };
    const tbR = thumbnailSettled.status === 'fulfilled' ? thumbnailSettled.value : { stats: { total: 0, failed: 0, error: thumbnailSettled.reason?.message }, thumbnails: {} };
    const fnR = funnelSettled.status    === 'fulfilled' ? funnelSettled.value    : { funnelContent: null, funnelImages: {}, funnelImageStats: { total: 0, failed: 0, error: funnelSettled.reason?.message }, instructorPhotoBlob: null };

    const workbookStats     = wbR.stats;
    const thumbnailStats    = tbR.stats;
    const thumbnails        = tbR.thumbnails || {};
    let   funnelContent     = fnR.funnelContent;
    let   funnelImages      = fnR.funnelImages || {};
    let   funnelImageStats  = fnR.funnelImageStats;
    let   instructorPhotoBlob = fnR.instructorPhotoBlob;
    console.log(`⚡ Parallel generation complete in ${Math.round((Date.now() - tParallel) / 1000)}s`);

    const draftId = randomUUID();
    drafts.set(draftId, {
      input: {
        mode, courseTitle, targetAudience, instructions, description,
        moduleCount: resolvedModuleCount,
        lessonsPerModule: resolvedLessonsPerModule,
        accent: accent || '#6366f1',
        sourceText,
        generateWorkbooks: wantWorkbooks,
        generateThumbnails: wantThumbnails,
        locationId,                                   // 👈 target sub-account for this draft
        // Funnel-specific inputs (kept so regen can re-use them)
        generateFunnel: generateFunnelFlag && !!funnelContent,
        instructorName: instructorName?.trim() || '',
        coursePrice: coursePrice?.trim() || '',
        brandPrimary: accent || '#6366f1',
        brandDarkBg: brandDarkBg || '#0A1C3D',
        funnelPitch: funnelPitch?.trim() || '',
      },
      structure,
      thumbnails,                                     // { course: b64, "m0-l0": b64, ... }
      generatedAt: Date.now(),
      workbookStats,
      thumbnailStats,
      // Funnel data on the draft (null/empty if toggle was off or generation failed)
      funnelContent,                                  // null or { hero, problem, ... }
      funnelImages,                                   // { module_1: b64, ..., pricing_laptop: b64 }
      funnelImageStats,
      instructorPhoto: instructorPhotoBlob,           // null or { buffer, mime, filename }
    });

    emit({
      phase: 'done',
      draftId,
      redirectUrl: `/preview/${draftId}`,
      regen: getRegenInfo(locationId),
      workbookStats,
      thumbnailStats,
      funnel: {
        generated: !!funnelContent,
        imageStats: funnelImageStats,
        imageKeys: Object.keys(funnelImages),
      },
    });
    res.end();
  } catch (err) {
    console.error('Generate error:', err);
    const friendly = humanizeAiError(err);
    // Stream may already be open — emit a final error event then end. If headers
    // weren't sent yet for some reason, fall back to a JSON 500.
    if (res.headersSent) {
      emit({ phase: 'error', error: friendly, raw: err.message });
      res.end();
    } else {
      res.status(500).json({ error: friendly, raw: err.message });
    }
  }
});

function humanizeAiError(err) {
  const msg = String(err?.message || err || '');
  if (/\b503\b|service unavailable|overloaded|high demand/i.test(msg)) {
    return 'Gemini is currently overloaded. Please wait a minute and try again. If this keeps happening, try setting GEMINI_TEXT_MODEL to gemini-3.5-flash or gemini-3.5-flash-lite in your env.';
  }
  if (/\b429\b|rate limit/i.test(msg)) {
    return 'Hit the Gemini rate limit / quota. Wait 30 seconds and try again. If this keeps happening, enable billing on your Google AI Studio project or lower AI_IMAGE_CONCURRENCY.';
  }
  if (/\b401\b|api key|unauthorized|invalid_api_key/i.test(msg)) {
    return 'Gemini rejected the API key. Check GEMINI_API_KEY in your env vars.';
  }
  if (/\b400\b|invalid argument|invalid_request/i.test(msg)) {
    return 'Gemini rejected the prompt. Try a shorter source PDF or simpler description.';
  }
  if (/timeout|timed.out|deadline/i.test(msg)) {
    return 'Gemini took too long to respond. Try a smaller course (fewer modules/lessons) or a shorter PDF.';
  }
  if (/model.*not.*found|model_not_found/i.test(msg)) {
    return `Model "${GEMINI_TEXT_MODEL}" not available. Try gemini-3.7-flash, gemini-3.5-flash, or gemini-3.5-flash-lite.`;
  }
  return err?.message || 'Generation failed';
}

// ---------------------------------------------------------------------
// API: Regenerate an existing draft (counts against the limit)
// ---------------------------------------------------------------------
app.post('/api/regenerate/:draftId', async (req, res) => {
  try {
    const { draftId } = req.params;
    const draft = drafts.get(draftId);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    const draftLocationId = draft.input.locationId || CC360_LOCATION_ID;
    const info = getRegenInfo(draftLocationId);
    if (info.remaining <= 0) {
      return res.status(429).json({
        error: `Regenerate limit reached (${info.limit}/${info.limit}) for this sub-account. Edit manually instead, or push as-is.`,
        regen: info,
      });
    }

    const i = draft.input;
    const structure = await generateCourseStructure({
      apiKey: GEMINI_API_KEY,
      model: GEMINI_TEXT_MODEL,
      mode: i.mode,
      sourceText: i.sourceText,
      courseTitle: i.courseTitle,
      targetAudience: i.targetAudience || 'general learners',
      instructions: i.instructions || '',
      moduleCount: resolveCount(i.moduleCount, DEFAULT_MODULE_COUNT),
      lessonsPerModule: resolveCount(i.lessonsPerModule, DEFAULT_LESSONS_PER_MODULE),
    });
    structure.courseTitle = i.courseTitle;

    // Re-generate workbooks too (if originally enabled)
    let workbookStats = { total: 0, failed: 0 };
    if (i.generateWorkbooks) {
      const r = await generateWorkbooksForCourse({
        apiKey: GEMINI_API_KEY,
        model: GEMINI_TEXT_MODEL,
        structure,
      });
      workbookStats = { total: r.total, failed: r.failed };
    }

    // Re-generate thumbnails too (if originally enabled)
    let thumbnailStats = { total: 0, failed: 0 };
    let thumbnails = {};
    if (i.generateThumbnails && IMAGES_ENABLED) {
      try {
        const r = await generateThumbnailsForCourse({
          apiKey: GEMINI_API_KEY,
          model: GEMINI_IMAGE_MODEL,
          imageSize: GEMINI_IMAGE_SIZE,
          structure,
          accent: i.accent || '#6366f1',
          targetAudience: i.targetAudience || '',
        });
        thumbnails = r.thumbnails;
        thumbnailStats = { total: r.total, failed: r.failed };
      } catch (e) {
        console.warn(`⚠️  Thumbnail regen failed: ${e.message}`);
        thumbnailStats = { total: 0, failed: 0, error: e.message };
      }
    }

    draft.structure = structure;
    draft.thumbnails = thumbnails;
    draft.generatedAt = Date.now();
    draft.workbookStats = workbookStats;
    draft.thumbnailStats = thumbnailStats;

    // Funnel regen — only if the draft originally generated a funnel
    let funnelInfo = { generated: false };
    if (i.generateFunnel && draft.funnelContent) {
      try {
        const funnelSeed = i.mode === 'description' ? (i.description || '') : (i.funnelPitch || '');
        console.log(`📝 Regenerating funnel copy for "${i.courseTitle}"...`);
        const newFunnelContent = await generateFunnelContent({
          apiKey: GEMINI_API_KEY,
          model: GEMINI_TEXT_MODEL,
          courseTitle: i.courseTitle,
          courseDescription: funnelSeed,
          instructorName: i.instructorName,
          coursePrice: i.coursePrice,
          brandPrimary: i.brandPrimary || i.accent,
          instructions: i.instructions || '',
        });
        let newImages = {};
        let newImageStats = { total: 0, failed: 0 };
        if (IMAGES_ENABLED) {
          try {
            const r = await generateFunnelImages({
              apiKey: GEMINI_API_KEY,
              model: GEMINI_IMAGE_MODEL,
              imageSize: GEMINI_IMAGE_SIZE,
              content: newFunnelContent,
              courseTitle: i.courseTitle,
              accent: i.brandPrimary || i.accent,
            });
            newImages = r.images;
            newImageStats = { total: r.total, failed: r.failed };
          } catch (e) {
            console.warn(`⚠️  Funnel image regen failed: ${e.message}`);
            newImageStats = { total: 9, failed: 9, error: e.message };
          }
        }
        draft.funnelContent = newFunnelContent;
        draft.funnelImages = newImages;
        draft.funnelImageStats = newImageStats;
        funnelInfo = {
          generated: true,
          content: newFunnelContent,
          imageStats: newImageStats,
          imageKeys: Object.keys(newImages),
        };
        console.log(`   ✓ Funnel regenerated`);
      } catch (e) {
        console.warn(`⚠️  Funnel regen failed: ${e.message}. Keeping existing funnel content.`);
        funnelInfo = { generated: true, content: draft.funnelContent, imageStats: draft.funnelImageStats, imageKeys: Object.keys(draft.funnelImages || {}), regenError: e.message };
      }
    }

    drafts.set(draftId, draft);

    const newInfo = bumpRegen(draftLocationId);
    res.json({ draftId, structure, regen: newInfo, workbookStats, thumbnailStats, funnel: funnelInfo });
  } catch (err) {
    console.error('Regenerate error:', err);
    const friendly = humanizeAiError(err);
    res.status(500).json({ error: friendly, raw: err.message });
  }
});

// ---------------------------------------------------------------------
// API: List available funnel themes (palette + snapshot id) for preview UI
// ---------------------------------------------------------------------
app.get('/api/themes', (_req, res) => {
  // Don't leak snapshot IDs to the public preview — the backend resolves
  // them server-side on push. Frontend only needs the palette and names.
  const safe = Object.fromEntries(
    Object.entries(THEMES).map(([key, t]) => [key, {
      name: t.name, primary: t.primary, soft: t.soft, tint: t.tint, dark: t.dark,
    }])
  );
  res.json({ themes: safe, default: DEFAULT_THEME });
});

// ---------------------------------------------------------------------
// API: Save edits to a draft
// ---------------------------------------------------------------------
app.put('/api/draft/:draftId', (req, res) => {
  const { draftId } = req.params;
  const draft = drafts.get(draftId);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const { structure, accent, funnelContent, brandPrimary, brandDarkBg, coursePrice, theme } = req.body;
  if (structure) draft.structure = structure;
  if (accent) draft.input.accent = accent;
  // Funnel edits — preview sends FLAT shape; convert back to nested so the
  // push pipeline (flattenToCustomValueMap) continues to see its expected shape.
  // Preserve any fields the preview doesn't edit by passing the existing
  // funnelContent as the base.
  if (funnelContent && typeof funnelContent === 'object') {
    draft.funnelContent = flatPreviewToNested(funnelContent, draft.funnelContent || {});
  }
  if (brandPrimary && /^#[0-9a-fA-F]{6}$/.test(brandPrimary)) draft.input.brandPrimary = brandPrimary;
  if (brandDarkBg && /^#[0-9a-fA-F]{6}$/.test(brandDarkBg)) draft.input.brandDarkBg = brandDarkBg;
  if (typeof coursePrice === 'string') draft.input.coursePrice = coursePrice;
  if (theme && isValidTheme(theme)) draft.input.theme = theme;
  drafts.set(draftId, draft);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// API: Render a single lesson to styled HTML (for live preview)
// ---------------------------------------------------------------------
app.post('/api/render', (req, res) => {
  const { lesson, accent, withWorkbook, draftId, mi, li } = req.body;
  if (!lesson) return res.status(400).json({ error: 'lesson is required' });
  const theme = buildTheme(accent || '#6366f1');
  const opts = {};
  // Wire workbook button to live preview endpoint when we have draft coordinates
  if (withWorkbook && lesson.workbook && draftId !== undefined && mi !== undefined && li !== undefined) {
    opts.workbookUrl = `/api/preview-pdf/${draftId}/${mi}/${li}`;
  }
  // (Thumbnails go to the proper sidebar field on push — not embedded in body.)
  res.json({ html: renderLessonHTML(lesson, theme, opts) });
});

// ---------------------------------------------------------------------
// API: Preview a thumbnail (course hero or lesson icon) as a PNG
// ---------------------------------------------------------------------
app.get('/api/preview-thumbnail/:draftId/:key', (req, res) => {
  try {
    const { draftId, key } = req.params;
    const draft = drafts.get(draftId);
    if (!draft) return res.status(404).send('Draft not found');
    const b64 = draft.thumbnails?.[key];
    if (!b64) return res.status(404).send('Thumbnail not generated for this key');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(base64ToBuffer(b64));
  } catch (err) {
    console.error('Preview thumbnail error:', err);
    res.status(500).send(`Thumbnail render failed: ${err.message}`);
  }
});

// ---------------------------------------------------------------------
// API: Preview a funnel image (module thumbnail or laptop mockup) as a PNG
// ---------------------------------------------------------------------
app.get('/api/preview-funnel-image/:draftId/:key', (req, res) => {
  try {
    const { draftId, key } = req.params;
    const draft = drafts.get(draftId);
    if (!draft) return res.status(404).send('Draft not found');
    const b64 = draft.funnelImages?.[key];
    if (!b64) return res.status(404).send('Funnel image not generated for this key');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(base64ToBuffer(b64));
  } catch (err) {
    console.error('Preview funnel image error:', err);
    res.status(500).send(`Funnel image render failed: ${err.message}`);
  }
});

// ---------------------------------------------------------------------
// API: Preview a lesson's workbook PDF (renders on-demand)
// ---------------------------------------------------------------------
app.get('/api/preview-pdf/:draftId/:mi/:li', async (req, res) => {
  try {
    const { draftId, mi, li } = req.params;
    const draft = drafts.get(draftId);
    if (!draft) return res.status(404).send('Draft not found');

    const buffer = await renderLessonWorkbookPdf({
      structure: draft.structure,
      accent: draft.input.accent || '#6366f1',
      mi: parseInt(mi, 10),
      li: parseInt(li, 10),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="workbook-preview.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('Preview PDF error:', err);
    res.status(500).send(`PDF render failed: ${err.message}`);
  }
});

// ---------------------------------------------------------------------
// API: Push a draft to CC360 (renders + uploads workbooks, then imports course)
// Streams progress as newline-delimited JSON so the client can show real-time
// checkpoints. Also pushes the AI funnel after the course if the draft has one.
// ---------------------------------------------------------------------
app.post('/api/push/:draftId', async (req, res) => {
  // Streaming response setup
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');     // Disable nginx buffering for true streaming
  res.flushHeaders?.();
  const emit = (event) => {
    try { res.write(JSON.stringify(event) + '\n'); } catch {}
  };

  try {
    const { draftId } = req.params;
    const draft = drafts.get(draftId);
    if (!draft) {
      emit({ phase: 'error', error: 'Draft not found' });
      return res.end();
    }

    const accent = draft.input.accent || '#6366f1';
    const draftLocationId = draft.input.locationId || CC360_LOCATION_ID;
    if (!isValidLocationId(draftLocationId)) {
      emit({ phase: 'error', error: 'Draft has no valid sub-account Location ID' });
      return res.end();
    }

    emit({ phase: 'start', locationId: draftLocationId, hasFunnel: !!draft.funnelContent });

    // Resolve the auth token for THIS sub-account (OAuth → PIT fallback)
    let authToken;
    try {
      const r = await resolveTokenForLocation(draftLocationId);
      authToken = r.token;
      console.log(`🔐 Auth source for ${draftLocationId}: ${r.source}`);
      emit({ phase: 'auth', status: 'done', source: r.source });
    } catch (e) {
      emit({ phase: 'error', error: `Cannot authenticate to sub-account ${draftLocationId}: ${e.message}` });
      return res.end();
    }

    // For thumbnail uploads we need a User-authClass JWT (the kind the CC360 web app uses).
    // The /membership/locations/{lid}/media/signed-url endpoint 401s on OAuth Location/Company
    // tokens — it only accepts User JWTs. Tony's User JWT is auto-synced by the agency-settings
    // snippet whenever he has CC360 open in a tab.
    let userJwtForUploads = null;
    let userJwtTokenId = null;
    try {
      const u = await getActiveUserJwt();
      if (u?.jwt) {
        userJwtForUploads = u.jwt;
        userJwtTokenId = u.tokenId || null;
        console.log(`🔐 User JWT loaded for thumbnail uploads${userJwtTokenId ? ' (with token-id)' : ''}`);
      } else {
        console.warn(`⚠️  No User JWT available — thumbnail uploads will be skipped. Paste a JWT at /setup or open CC360 in a tab so the snippet syncs one.`);
      }
    } catch (e) {
      console.warn(`⚠️  Could not load User JWT: ${e.message}`);
    }

    const workbookUrlByLessonKey = {};
    const thumbnailUrlByLessonKey = {};
    let courseThumbnailUrl = null;
    const uploadResults = [];   // for response

    // 0. Upload thumbnails first — MUST go to the courses CDN (cdn.courses.apisystem.tech),
    // NOT the general media library. GHL's courses-exporter import endpoint silently
    // drops posterImage URLs from anywhere else, which is why thumbnails weren't sticking.
    // The signed-url endpoint requires a User-authClass JWT (OAuth tokens get 401).
    const thumbnails = draft.thumbnails || {};
    const thumbnailKeys = Object.keys(thumbnails);
    if (thumbnailKeys.length > 0 && !userJwtForUploads) {
      console.warn(`⚠️  ${thumbnailKeys.length} thumbnails generated but skipping upload — no User JWT available.`);
      console.warn(`   Open CC360 in a tab (snippet auto-syncs JWT) or paste one at /setup, then re-push.`);
    } else if (thumbnailKeys.length > 0) {
      console.log(`🖼️  Uploading ${thumbnailKeys.length} thumbnails to courses CDN...`);
      for (const key of thumbnailKeys) {
        const b64 = thumbnails[key];
        if (!b64) continue;
        try {
          const buf = base64ToBuffer(b64);
          const baseName = key === 'course'
            ? `${slug(draft.structure.courseTitle, 40)}-cover`
            : `${slug(draft.structure.courseTitle, 30)}-${key}-thumb`;
          // Match GHL's own URL structure: course thumbnails live under /courses/,
          // lesson thumbnails under /posts/ (membership API calls lessons "posts").
          // The import endpoint validates posterImage URLs match these path prefixes.
          const folder = key === 'course' ? 'courses' : 'posts';
          const { publicUrl } = await uploadCourseMedia({
            token: userJwtForUploads,             // User JWT (NOT the OAuth token)
            tokenId: userJwtTokenId,              // Firebase ID token, if synced
            locationId: draftLocationId,
            buffer: buf,
            filename: baseName,
            folder,
            mimeType: 'image/png',
          });
          if (key === 'course') {
            courseThumbnailUrl = publicUrl;
          } else {
            thumbnailUrlByLessonKey[key] = publicUrl;
          }
          uploadResults.push({ key: `thumb:${key}`, url: publicUrl, ok: true });
          console.log(`   ✓ Thumbnail [${key}] → ${publicUrl}`);
        } catch (e) {
          console.warn(`   ✗ Thumbnail [${key}] upload failed: ${e.message}`);
          uploadResults.push({ key: `thumb:${key}`, ok: false, error: e.message });
        }
      }
    }

    // 1. For each lesson with workbook content, render PDF + upload to media library
    const modules = draft.structure.modules || [];
    let totalToUpload = 0;
    modules.forEach(m => (m.lessons || []).forEach(l => { if (l.workbook) totalToUpload++; }));

    if (totalToUpload > 0) {
      console.log(`📤 Pushing course "${draft.structure.courseTitle}" to ${draftLocationId} — uploading ${totalToUpload} workbook PDFs...`);
      emit({ phase: 'workbooks', status: 'start', total: totalToUpload });
    }

    for (let mi = 0; mi < modules.length; mi++) {
      const lessons = modules[mi].lessons || [];
      for (let li = 0; li < lessons.length; li++) {
        const lesson = lessons[li];
        if (!lesson.workbook) continue;

        const key = `m${mi}-l${li}`;
        try {
          const pdfBuffer = await renderLessonWorkbookPdf({
            structure: draft.structure, accent, mi, li,
          });
          const filename = `${slug(draft.structure.courseTitle, 30)}-l${String(mi + 1).padStart(2, '0')}-${String(li + 1).padStart(2, '0')}-${slug(lesson.title, 40)}.pdf`;
          const { url } = await uploadToMediaLibrary({
            pit: authToken,
            locationId: draftLocationId,
            buffer: pdfBuffer,
            filename,
            contentType: 'application/pdf',
          });
          workbookUrlByLessonKey[key] = url;
          uploadResults.push({ key, lesson: lesson.title, url, ok: true });
          console.log(`   ✓ [${mi + 1}.${li + 1}] ${lesson.title}`);
        } catch (e) {
          console.warn(`   ✗ [${mi + 1}.${li + 1}] ${lesson.title} — upload failed: ${e.message}`);
          uploadResults.push({ key, lesson: lesson.title, ok: false, error: e.message });
        }
      }
    }

    // 2. Import the course with thumbnails baked into the payload.
    // The import endpoint MAY honor `posterImage` on products and posts — if so, thumbnails
    // attach during create and we're done. If not, attachThumbnails() below runs as a
    // best-effort fallback (only if CC360_USER_JWT is configured for backend.* auth).
    console.log(`📚 Importing course to CC360 sub-account ${draftLocationId}...`);
    emit({ phase: 'workbooks', status: 'done', uploaded: Object.keys(workbookUrlByLessonKey).length, total: totalToUpload });
    emit({ phase: 'course-import', status: 'start' });
    const result = await importCourse({
      pit: authToken,
      locationId: draftLocationId,
      draft: draft.structure,
      accent,
      workbookUrlByLessonKey,
      courseThumbnailUrl,
      thumbnailUrlByLessonKey,
    });
    console.log(`   ✓ Course created: ${result.url}`);
    emit({ phase: 'course-import', status: 'done', url: result.url, title: result.title });
    if (courseThumbnailUrl || Object.keys(thumbnailUrlByLessonKey).length > 0) {
      console.log(`   (posterImage fields included in import payload — open the course in CC360 to verify they took effect)`);
    }

    // 3. Attach thumbnails server-side via services.leadconnectorhq.com.
    // Cloudflare WAF allowlists by Origin header — using the iframe origin
    // (backend.memberships.apisystem.tech) lets us through. Browsers can't spoof
    // Origin, but Node can, so this works server-side.
    let thumbnailAttachResults = null;
    const hasThumbnailsToAttach = courseThumbnailUrl || Object.keys(thumbnailUrlByLessonKey).length > 0;
    if (hasThumbnailsToAttach) {
      if (!userJwtForUploads) {
        console.warn(`⚠️  Have thumbnails ready to attach but no User JWT loaded — skipping. Paste one at /setup.`);
        thumbnailAttachResults = { error: 'no User JWT' };
      } else {
        try {
          console.log(`🖼️  Attaching thumbnails server-side via backend.leadconnectorhq.com...`);
          thumbnailAttachResults = await attachThumbnails({
            backendToken: userJwtForUploads,
            backendTokenId: userJwtTokenId,
            locationId: draftLocationId,
            productId: result.id,
            courseTitle: draft.structure.courseTitle,
            courseDescription: draft.structure.courseDescription || `Course built on ${new Date().toLocaleDateString()}`,
            courseThumbnailUrl,
            lessonThumbnailMap: thumbnailUrlByLessonKey,
            onProgress: ({ phase, error, totalPosts, expected, elapsedMs }) => {
              if (phase === 'polling') {
                const secs = elapsedMs ? Math.round(elapsedMs / 1000) : 0;
                console.log(`   [attach] polling: ${totalPosts ?? '?'}/${expected ?? '?'} lessons ready (${secs}s elapsed)`);
                return;
              }
              const errStr = error ? ': ' + (typeof error === 'string' ? error : JSON.stringify(error)).slice(0, 250) : '';
              console.log(`   [attach] ${phase}${errStr}`);
            },
          });
          const courseOk = thumbnailAttachResults.course?.ok;
          const lessonsOk = (thumbnailAttachResults.lessons || []).filter(l => l.ok).length;
          const lessonsTotal = (thumbnailAttachResults.lessons || []).length;
          const courseSymbol = courseOk === undefined ? '—' : (courseOk ? '✓' : '✗');
          console.log(`   ✓ Thumbnail attach result: course=${courseSymbol}, lessons=${lessonsOk}/${lessonsTotal}`);
          if (courseOk === false) {
            const errStr = typeof thumbnailAttachResults.course.error === 'string'
              ? thumbnailAttachResults.course.error : JSON.stringify(thumbnailAttachResults.course.error);
            console.warn(`     ↳ course error: ${errStr.slice(0, 400)}`);
          }
          for (const lr of thumbnailAttachResults.lessons || []) {
            if (!lr.ok) {
              const errStr = typeof lr.error === 'string' ? lr.error : JSON.stringify(lr.error);
              console.warn(`     ↳ lesson ${lr.key} error: ${errStr.slice(0, 400)}`);
            }
          }
        } catch (e) {
          console.warn(`⚠️  Thumbnail attach failed: ${e.message}`);
          thumbnailAttachResults = { error: e.message };
        }
      }
    }

    draft.pushedAt = Date.now();
    draft.cc360 = result;
    draft.uploadResults = uploadResults;
    draft.courseThumbnailUrl = courseThumbnailUrl;
    draft.thumbnailAttachResults = thumbnailAttachResults;
    drafts.set(draftId, draft);

    const courseResult = {
      ...result,
      courseThumbnailUrl,
      thumbnailAttach: thumbnailAttachResults,
      workbooks: {
        total: totalToUpload,
        succeeded: uploadResults.filter(r => r.ok && !r.key.startsWith('thumb:')).length,
        failed: uploadResults.filter(r => !r.ok && !r.key.startsWith('thumb:')).length,
        results: uploadResults.filter(r => !r.key.startsWith('thumb:')),
      },
      thumbnails: {
        course: courseThumbnailUrl,
        lessons: thumbnailUrlByLessonKey,
        results: uploadResults.filter(r => r.key.startsWith('thumb:')),
        attached: thumbnailAttachResults,
      },
    };
    emit({ phase: 'course', status: 'done', result: courseResult });

    // 4. (Optional) Push the AI funnel if the draft has one
    let funnelResult = null;
    if (draft.funnelContent) {
      emit({ phase: 'funnel', status: 'start' });

      // ────────────────────────────────────────────────────────────────
      // 4-pre. Apply the chosen theme's funnel template to the sub-account.
      // Mirrors the same step in /api/funnel-only/push — uses GHL's
      // "clone funnel to locations" share endpoint (bit-perfect copy).
      // Without this, the customValues + images get pushed but there's
      // no themed funnel page to render them into.
      //
      // Failure here is non-fatal: customValues + images still go through
      // so if a themed funnel already exists in the sub-account (e.g. from
      // a previous push), it picks up the updated content.
      // ────────────────────────────────────────────────────────────────
      const themeKey = isValidTheme(draft.input.theme) ? draft.input.theme : DEFAULT_THEME;
      const theme = getTheme(themeKey);
      const cloneFunnelName = `Content Generation Studio Funnel (${theme.name}-Theme)`;
      emit({ phase: 'theme-snapshot', status: 'start', theme: themeKey, funnelId: theme.funnelId });
      try {
        if (!theme.funnelId) {
          throw new Error(`Theme "${themeKey}" has no funnelId mapped in lib/funnel-themes.js.`);
        }
        const userAuth = await getActiveUserJwt();
        if (!userAuth?.jwt) {
          throw new Error('No User JWT available — paste one at /setup or open CC360 in a tab so the snippet syncs one.');
        }
        const cloneResult = await cloneFunnelToLocations({
          funnelId: theme.funnelId,
          funnelName: cloneFunnelName,
          targetLocationIds: draftLocationId,
          userJwt: userAuth.jwt,
          tokenId: userAuth.tokenId,
        });
        console.log(`   ✓ Funnel ${theme.funnelId} (${themeKey}) cloned to ${draftLocationId} as "${cloneFunnelName}"; traceId=${cloneResult.traceId || '?'}`);
        emit({ phase: 'theme-snapshot', status: 'propagating' });
        await waitForCloneVisibility(4000);
        emit({ phase: 'theme-snapshot', status: 'done', theme: themeKey, funnelName: cloneFunnelName });
      } catch (e) {
        console.warn(`   ⚠ Funnel clone failed (continuing with values push): ${e.message}`);
        emit({ phase: 'theme-snapshot', status: 'failed', error: e.message, note: 'Continuing — any existing themed funnel in this sub-account will still receive updated content via customValues' });
      }

      // 4a. Upload instructor photo
      let instructorPhotoUrl = null;
      if (draft.instructorPhoto?.buffer) {
        emit({ phase: 'funnel-photo', status: 'start' });
        try {
          instructorPhotoUrl = await uploadInstructorPhoto({
            token: authToken,
            locationId: draftLocationId,
            buffer: draft.instructorPhoto.buffer,
            filename: `instructor-${slug(draft.input.instructorName, 30)}-${Date.now()}.jpg`,
            mimeType: draft.instructorPhoto.mime || 'image/jpeg',
          });
          console.log(`   ✓ Instructor photo → ${instructorPhotoUrl}`);
          emit({ phase: 'funnel-photo', status: 'done', url: instructorPhotoUrl });
        } catch (e) {
          console.warn(`   ✗ Instructor photo upload failed: ${e.message}`);
          emit({ phase: 'funnel-photo', status: 'failed', error: e.message });
        }
      }

      // 4b. Upload funnel images (8 module thumbs + laptop)
      let funnelImageUrls = {};
      const funnelImageFails = [];
      if (draft.funnelImages && Object.keys(draft.funnelImages).length > 0) {
        emit({ phase: 'funnel-images', status: 'start', total: Object.keys(draft.funnelImages).length });
        try {
          const r = await uploadFunnelImages({
            token: authToken,
            locationId: draftLocationId,
            imageMap: draft.funnelImages,
            coursePrefix: draft.input.courseTitle,
          });
          funnelImageUrls = r.urls;
          funnelImageFails.push(...r.failed);
          console.log(`   ✓ Funnel images uploaded: ${Object.keys(r.urls).length}/${Object.keys(draft.funnelImages).length}`);
          emit({ phase: 'funnel-images', status: 'done', uploaded: Object.keys(r.urls).length, failed: r.failed.length });
        } catch (e) {
          console.warn(`   ✗ Funnel image upload failed: ${e.message}`);
          emit({ phase: 'funnel-images', status: 'failed', error: e.message });
        }
      }

      // 4c. Build the value map and push custom values
      const valueMap = flattenToCustomValueMap(draft.funnelContent, {
        coursePrice: draft.input.coursePrice,
        footerYear: new Date().getFullYear(),
      });
      valueMap.instructor_name = draft.input.instructorName;
      // Note: brand_primary / brand_dark_bg / section bg custom values are NOT
      // written — the themed funnel template owns those colors and backgrounds.
      // Writing them here would have no effect (no merge tag in the template).
      if (instructorPhotoUrl) valueMap.instructor_photo_url = instructorPhotoUrl;
      for (let i = 1; i <= 8; i++) {
        const k = `module_${i}`;
        if (funnelImageUrls[k]) valueMap[`module_${i}_image_url`] = funnelImageUrls[k];
      }
      if (funnelImageUrls.pricing_laptop) valueMap.pricing_laptop_image = funnelImageUrls.pricing_laptop;
      // Inside-card icons (6 — for "What You Will Get in This Course")
      for (let i = 1; i <= 6; i++) {
        const k = `inside_card_${i}_icon`;
        if (funnelImageUrls[k]) valueMap[`inside_card_${i}_icon_url`] = funnelImageUrls[k];
      }

      emit({ phase: 'funnel-customvalues', status: 'start', total: Object.keys(valueMap).length });
      let cvResult;
      try {
        cvResult = await pushCustomValues({ token: authToken, locationId: draftLocationId, valueMap });
        console.log(`   ✓ Custom values: updated=${cvResult.updated.length}, created=${cvResult.created.length}, failed=${cvResult.failed.length}`);
        emit({
          phase: 'funnel-customvalues',
          status: 'done',
          updated: cvResult.updated.length,
          created: cvResult.created.length,
          failed: cvResult.failed.length,
          failures: cvResult.failed,
        });
      } catch (e) {
        console.warn(`   ✗ Custom values push failed: ${e.message}`);
        emit({ phase: 'funnel-customvalues', status: 'failed', error: e.message });
        cvResult = { updated: [], created: [], failed: [] };
      }

      funnelResult = {
        instructorPhotoUrl,
        funnelImageUrls,
        funnelImageFails,
        customValues: {
          updated: cvResult.updated.length,
          created: cvResult.created.length,
          failed: cvResult.failed.length,
          failures: cvResult.failed,
        },
      };
      draft.funnelPushResult = funnelResult;
      drafts.set(draftId, draft);
      emit({ phase: 'funnel', status: 'done', result: funnelResult });
    }

    // Final
    emit({ phase: 'done', course: courseResult, funnel: funnelResult });
    res.end();
  } catch (err) {
    console.error('Push error:', err);
    emit({ phase: 'error', error: err.message || 'Push failed', details: err.response?.data });
    res.end();
  }
});

// ---------------------------------------------------------------------
// API: Get draft info (for refresh/recovery)
// ---------------------------------------------------------------------
app.get('/api/draft/:draftId', (req, res) => {
  const draft = drafts.get(req.params.draftId);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  const draftLocationId = draft.input.locationId || CC360_LOCATION_ID;
  // Don't ship base64 image data over the wire — just tell the client which keys exist
  const thumbnailKeys = Object.keys(draft.thumbnails || {});
  const funnelImageKeys = Object.keys(draft.funnelImages || {});
  res.json({
    draftId: req.params.draftId,
    structure: draft.structure,
    accent: draft.input.accent,
    locationId: draftLocationId,
    regen: getRegenInfo(draftLocationId),
    pushedAt: draft.pushedAt || null,
    cc360: draft.cc360 || null,
    courseThumbnailUrl: draft.courseThumbnailUrl || null,
    workbookStats: draft.workbookStats || null,
    thumbnailStats: draft.thumbnailStats || null,
    thumbnailKeys,
    uploadResults: draft.uploadResults || null,
    // Funnel data
    funnel: {
      generated: !!draft.funnelContent,
      // The interactive preview consumes a FLAT shape. We always convert from
      // the canonical nested funnelContent at the response boundary so the
      // server-side data structure stays consistent with flattenToCustomValueMap.
      content: draft.funnelContent
        ? nestedToFlatPreview(draft.funnelContent, draft.input || {})
        : null,
      input: {
        instructorName: draft.input.instructorName || '',
        coursePrice: draft.input.coursePrice || '',
        brandPrimary: draft.input.brandPrimary || draft.input.accent || '#6366f1',
        brandDarkBg: draft.input.brandDarkBg || '#0A1C3D',
        theme: draft.input.theme || null,
      },
      imageStats: draft.funnelImageStats || null,
      imageKeys: funnelImageKeys,
      pushResult: draft.funnelPushResult || null,
    },
  });
});

// ---------------------------------------------------------------------
// API: Misc
// ---------------------------------------------------------------------
app.get('/api/config', (_req, res) => {
  res.json({
    multiTenant: true,
    defaultLocationId: CC360_LOCATION_ID || null,    // used by the form as an initial hint, optional
    regenLimit: Number(REGEN_LIMIT),
  });
});

// ---------------------------------------------------------------------
// OAuth routes — Agency Marketplace App install flow
// ---------------------------------------------------------------------
app.get('/oauth/install', (req, res) => {
  if (!oauthConfigured) {
    return res.status(500).send('OAuth is not configured. Set GHL_CLIENT_ID, GHL_CLIENT_SECRET, GHL_OAUTH_REDIRECT_URI in env.');
  }
  const state = newState(req.query.returnTo || '/setup');
  const url = buildAuthorizeUrl({
    clientId: GHL_CLIENT_ID,
    redirectUri: GHL_OAUTH_REDIRECT_URI,
    scopes: GHL_OAUTH_SCOPES,
    state,
  });
  res.redirect(url);
});

app.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state, error: ghlError } = req.query;
    if (ghlError) {
      return res.redirect(`/setup?error=${encodeURIComponent(String(ghlError))}`);
    }
    if (!code) {
      return res.redirect(`/setup?error=${encodeURIComponent('Missing authorization code')}`);
    }
    // State is OPTIONAL — present when install came from our /setup page (CSRF protection),
    // absent when install came from external entry points (GHL dev console install link,
    // in-platform App Marketplace, etc). We accept both.
    const stateData = state ? consumeState(state) : null;
    if (state && !stateData) {
      console.warn(`⚠️  OAuth callback received unknown/expired state="${state}" — proceeding anyway (probably an external install entry point).`);
    }

    const tokenData = await exchangeCodeForToken({
      code,
      clientId: GHL_CLIENT_ID,
      clientSecret: GHL_CLIENT_SECRET,
      userType: 'Location',
      redirectUri: GHL_OAUTH_REDIRECT_URI,
    });

    // Log the full response shape (with token strings redacted) so we can see exactly
    // what GHL is sending — GHL has changed response shapes between API versions and
    // we need to map fields correctly.
    const redacted = Object.fromEntries(
      Object.entries(tokenData || {}).map(([k, v]) => [
        k,
        /token/i.test(k) && typeof v === 'string'
          ? `${v.slice(0, 12)}...(${v.length} chars)`
          : v
      ])
    );
    console.log(`🔍 OAuth token response:`, JSON.stringify(redacted));

    // Try multiple field-name variations — GHL v2 may use different casing or nesting
    const locationId =
      tokenData.locationId ||
      tokenData.location_id ||
      tokenData.locationID ||
      tokenData.location?.id ||
      null;
    const companyId = tokenData.companyId || tokenData.company_id || null;
    const userType = tokenData.userType || tokenData.user_type || 'Location';

    // Path A: Sub-Account-level install (we have a locationId directly)
    if (locationId) {
      await tokenStore.saveInstallation({
        locationId,
        companyId,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: Date.now() + ((tokenData.expires_in || 86400) * 1000),
        scopes: tokenData.scope || GHL_OAUTH_SCOPES,
        installedAt: Date.now(),
        locationName: tokenData.locationName || null,
        companyName: tokenData.companyName || null,
        kind: 'location',
      });
      console.log(`✅ OAuth install (location): sub-account ${locationId}`);
      return res.redirect(`${stateData?.returnTo || '/setup'}?installed=1`);
    }

    // Path B: Agency-level install (Company token, no locationId yet — we mint per location on demand)
    if (userType === 'Company' && companyId) {
      await tokenStore.saveInstallation({
        locationId: `company:${companyId}`,                  // synthetic key, never a real locationId
        companyId,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: Date.now() + ((tokenData.expires_in || 86400) * 1000),
        scopes: tokenData.scope || GHL_OAUTH_SCOPES,
        installedAt: Date.now(),
        companyName: tokenData.companyName || null,
        kind: 'company',
      });
      console.log(`✅ OAuth install (company): ${companyId} — location tokens will be minted on demand`);
      return res.redirect(`${stateData?.returnTo || '/setup'}?installed=1`);
    }

    // Neither path matched — surface what we got
    const fieldList = Object.keys(tokenData || {}).join(', ') || '(none)';
    return res.redirect(`/setup?error=${encodeURIComponent(
      `Token exchange succeeded but no usable identity. userType=${userType}, fields: ${fieldList}.`
    )}`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`/setup?error=${encodeURIComponent(err.message)}`);
  }
});

app.get('/api/installations', async (_req, res) => {
  try {
    const list = await tokenStore.listInstallations();
    const subAccountInstalls = list.filter(i => i.kind !== 'company' && i.kind !== 'user-jwt' && i.locationId !== USER_JWT_KEY);
    const companyInstalls    = list.filter(i => i.kind === 'company');
    const installations = subAccountInstalls.map(i => ({
      locationId: i.locationId,
      locationName: i.locationName,
      companyId: i.companyId,
      companyName: i.companyName,
      installedAt: i.installedAt,
      expiresAt: i.expiresAt,
      scopes: i.scopes,
      kind: i.kind || 'location',
    }));
    const agencies = companyInstalls.map(c => ({
      companyId: c.companyId,
      companyName: c.companyName,
      installedAt: c.installedAt,
      scopes: c.scopes,
    }));
    res.json({ installations, agencies, oauthConfigured });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/installations/:locationId', async (req, res) => {
  try {
    await tokenStore.deleteInstallation(req.params.locationId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------
// User JWT — pasted from CC360 browser session, used for backend.* calls
// (the only auth class that endpoint accepts, per GHL's design)
// ---------------------------------------------------------------------
const USER_JWT_KEY = '__user_jwt__';

function decodeJwtPayload(jwt) {
  try {
    const parts = String(jwt).split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64').toString());
  } catch { return null; }
}

// CORS for the user-jwt endpoints — the bookmarklet runs on app.coursecreator360.com
// and needs to POST cross-origin to our /api/user-jwt
function setJwtCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

app.options('/api/user-jwt', (_req, res) => { setJwtCors(res); res.sendStatus(204); });

app.get('/api/user-jwt', async (_req, res) => {
  setJwtCors(res);
  try {
    const stored = await tokenStore.getInstallation(USER_JWT_KEY);
    const envJwt = CC360_USER_JWT;
    const active = stored?.accessToken || envJwt || null;
    if (!active) {
      return res.json({ set: false, source: null });
    }
    const payload = decodeJwtPayload(active);
    const expiresAt = payload?.exp ? payload.exp * 1000 : (stored?.expiresAt || null);
    const now = Date.now();
    res.json({
      set: true,
      source: stored?.accessToken ? 'pasted' : 'env',
      authClass: payload?.authClass || null,
      userId: payload?.authClassId || null,
      installedAt: stored?.installedAt || null,
      expiresAt,
      expired: expiresAt ? expiresAt < now : null,
      minutesRemaining: expiresAt ? Math.round((expiresAt - now) / 60000) : null,
      minutesSinceSync: stored?.installedAt ? Math.round((now - stored.installedAt) / 60000) : null,
      hasTokenId: !!stored?.tokenId,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/user-jwt', async (req, res) => {
  setJwtCors(res);
  try {
    const jwt = String(req.body?.jwt || '').trim().replace(/^Bearer\s+/i, '');
    const tokenId = String(req.body?.tokenId || '').trim();
    if (!jwt) return res.status(400).json({ error: 'JWT is required' });

    const payload = decodeJwtPayload(jwt);
    if (!payload) return res.status(400).json({ error: 'JWT is not parseable. Make sure you copied the whole token (three dot-separated parts).' });
    if (payload.authClass !== 'User') {
      return res.status(400).json({ error: `JWT has authClass="${payload.authClass}", but we need authClass="User". The bookmarklet must be clicked while logged into CC360 in the browser tab.` });
    }
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return res.status(400).json({ error: `JWT already expired ${Math.round((Date.now() - payload.exp * 1000) / 60000)} min ago. Grab a fresher one.` });
    }

    await tokenStore.saveInstallation({
      locationId: USER_JWT_KEY,
      accessToken: jwt,
      tokenId: tokenId || null,        // Firebase ID token header for backend.* CSRF check
      expiresAt: payload.exp ? payload.exp * 1000 : null,
      kind: 'user-jwt',
      userId: payload.authClassId || null,
      installedAt: Date.now(),
    });

    res.json({
      ok: true,
      expiresAt: payload.exp * 1000,
      minutesRemaining: Math.round((payload.exp * 1000 - Date.now()) / 60000),
      hasTokenId: !!tokenId,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/user-jwt', async (_req, res) => {
  setJwtCors(res);
  try {
    await tokenStore.deleteInstallation(USER_JWT_KEY);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper: get the currently-active user JWT (DB-stored takes precedence over env)
async function getActiveUserJwt() {
  try {
    const stored = await tokenStore.getInstallation(USER_JWT_KEY);
    if (stored?.accessToken) {
      const payload = decodeJwtPayload(stored.accessToken);
      if (payload?.exp && payload.exp * 1000 > Date.now() + 60_000) {
        return { jwt: stored.accessToken, tokenId: stored.tokenId || null };
      }
    }
  } catch {}
  return CC360_USER_JWT ? { jwt: CC360_USER_JWT, tokenId: null } : null;
}

// ---------------------------------------------------------------------
// Test endpoint: clone a funnel into a target sub-account via the SHARE
// endpoint (instead of snapshot loading). Produces a bit-perfect copy of
// the funnel — no missing elements. Zero AI cost.
//
// POST /api/test-funnel-share
//   body: { locationId, themeKey?, funnelId?, funnelName? }
// ---------------------------------------------------------------------
app.post('/api/test-funnel-share', async (req, res) => {
  const t0 = Date.now();
  try {
    const { locationId, themeKey, funnelId: funnelIdOverride, funnelName: funnelNameOverride } = req.body || {};
    if (!locationId) return res.status(400).json({ error: 'locationId is required' });
    if (!isValidLocationId(locationId)) return res.status(400).json({ error: 'locationId looks malformed' });

    const themeKeyToUse = isValidTheme(themeKey) ? themeKey : DEFAULT_THEME;
    const theme = getTheme(themeKeyToUse);
    const funnelIdToUse = funnelIdOverride || theme.funnelId;
    if (!funnelIdToUse) {
      return res.status(400).json({ error: `Theme "${themeKeyToUse}" has no funnelId mapped, and none provided in body.` });
    }
    const funnelNameToUse = funnelNameOverride || `Content Generation Studio Funnel (${theme.name}-Theme)`;

    const userAuth = await getActiveUserJwt();
    if (!userAuth?.jwt) {
      return res.status(400).json({ error: 'No User JWT available. Paste one at /setup.' });
    }

    // Diagnostics
    const jwtPayload = decodeJwtPayload(userAuth.jwt) || {};
    const tokenIdPayload = decodeJwtPayload(userAuth.tokenId) || {};
    const jwtMinLeft = jwtPayload.exp ? Math.round((jwtPayload.exp * 1000 - Date.now()) / 60000) : null;
    const tidMinLeft = tokenIdPayload.exp ? Math.round((tokenIdPayload.exp * 1000 - Date.now()) / 60000) : null;
    const tokenIdLocations = Array.isArray(tokenIdPayload.locations) ? tokenIdPayload.locations : null;
    const targetInTokenLocations = tokenIdLocations ? tokenIdLocations.includes(locationId) : null;

    const result = await cloneFunnelToLocations({
      funnelId: funnelIdToUse,
      funnelName: funnelNameToUse,
      targetLocationIds: locationId,
      userJwt: userAuth.jwt,
      tokenId: userAuth.tokenId,
    });

    res.json({
      ok: true,
      theme: themeKeyToUse,
      funnelId: funnelIdToUse,
      funnelName: funnelNameToUse,
      locationId,
      elapsedMs: Date.now() - t0,
      jwt: {
        minutesRemaining: jwtMinLeft,
        hasTokenId: !!userAuth.tokenId,
        tokenIdMinutesRemaining: tidMinLeft,
        targetInTokenLocations,            // null if no token-id, true/false otherwise
        tokenLocationCount: tokenIdLocations ? tokenIdLocations.length : null,
      },
      ...result,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      elapsedMs: Date.now() - t0,
      error: e.message,
    });
  }
});




// ---------------------------------------------------------------------
function setFinalizeCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}
app.options('/api/finalize/*', (_req, res) => { setFinalizeCors(res); res.sendStatus(204); });

// List all jobs (pending + recently completed) — UI filters them
app.get('/api/finalize', async (_req, res) => {
  setFinalizeCors(res);
  try {
    const all = await tokenStore.listInstallations();
    const jobs = all
      .filter(i => i.kind === 'thumbnail-job' && i.payload)
      .map(i => i.payload)
      .sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt));
    res.json({ jobs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get a specific job (the finalize page calls this on load)
app.get('/api/finalize/:jobId', async (req, res) => {
  setFinalizeCors(res);
  try {
    const stored = await tokenStore.getInstallation(`__job__${req.params.jobId}`);
    if (!stored?.payload) return res.status(404).json({ error: 'Job not found or already cleaned up' });
    res.json({ job: stored.payload });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mark a job complete with result data
app.post('/api/finalize/:jobId/complete', async (req, res) => {
  setFinalizeCors(res);
  try {
    const key = `__job__${req.params.jobId}`;
    const stored = await tokenStore.getInstallation(key);
    if (!stored?.payload) return res.status(404).json({ error: 'Job not found' });

    const result = req.body || {};
    const updatedJob = {
      ...stored.payload,
      status: result.allOk ? 'complete' : 'partial',
      completedAt: Date.now(),
      result,
    };
    await tokenStore.saveInstallation({
      locationId: key,
      accessToken: 'thumbnail-job',
      kind: 'thumbnail-job',
      installedAt: stored.installedAt,
      payload: updatedJob,
    });
    console.log(`🖼️  Thumbnail job ${req.params.jobId} ${updatedJob.status}: course=${result.course?.ok ? '✓' : '✗'}, lessons=${result.lessonsOk || 0}/${result.lessonsTotal || 0}`);
    if (!result.allOk) {
      const firstErr = result.course?.error || result.lessons?.find(l => !l.ok)?.error || result.error || '(no error captured)';
      console.log(`   ↳ first error: ${firstErr}`);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------
// Routing for HTML pages
// ---------------------------------------------------------------------
app.get('/jobs', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'jobs.html'));
});

app.get('/preview/:draftId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview.html'));
});

// ---------------------------------------------------------------------
// FUNNEL-ONLY PATH — generate + push the funnel without a course
// Useful for verifying OAuth scopes, custom value mapping, and image uploads
// without spending credits on full course generation. Also a real entry point
// for customers who only want a funnel (no course).
// ---------------------------------------------------------------------
app.get('/funnel-only', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'funnel-only.html'));
});
app.get('/funnel-preview/:draftId', (req, res) => {
  // Redirect to the new visual preview (form-based preview kept available at
  // /funnel-preview-classic for fallback / debugging).
  res.redirect(`/funnel-visual-preview.html?draft=${encodeURIComponent(req.params.draftId)}`);
});
app.get('/funnel-preview-classic/:draftId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'funnel-preview.html'));
});

app.post(
  '/api/funnel-only/generate',
  upload.single('instructorPhoto'),
  async (req, res) => {
    try {
      const { courseTitle, coursePitch, instructorName, coursePrice, instructions } = req.body;
      // Brand colors are no longer chosen by the user — they're baked into the
      // 5 themed funnel templates. Accept any value the form sends for backward
      // compat, but fall back to sensible defaults so we don't 400 on empty.
      const HEX = /^#[0-9a-fA-F]{6}$/;
      const brandPrimary = HEX.test(req.body.brandPrimary || '') ? req.body.brandPrimary : '#6366f1';
      const brandDarkBg  = HEX.test(req.body.brandDarkBg  || '') ? req.body.brandDarkBg  : '#0A1C3D';
      const skipImages = req.body.skipImages === 'true' || req.body.skipImages === true;
      const locationId = pickLocationId(req.body.locationId);

      // Validation
      if (!locationId) return res.status(400).json({ error: 'Sub-account Location ID is required' });
      if (!isValidLocationId(locationId)) return res.status(400).json({ error: 'Location ID looks malformed' });
      if (!courseTitle?.trim()) return res.status(400).json({ error: 'Course title is required' });
      if (!coursePitch || coursePitch.trim().length < 20) return res.status(400).json({ error: 'Course pitch must be at least 20 characters (1-3 sentences describing the transformation)' });
      if (!instructorName?.trim()) return res.status(400).json({ error: 'Instructor first name is required' });
      if (!coursePrice?.trim()) return res.status(400).json({ error: 'Course price is required' });
      if (!req.file) return res.status(400).json({ error: 'Instructor photo upload is required' });

      console.log(`📝 [funnel-only] Generating funnel for "${courseTitle}" → ${locationId} (skipImages=${skipImages})...`);
      const funnelContent = await generateFunnelContent({
        apiKey: GEMINI_API_KEY,
        model: GEMINI_TEXT_MODEL,
        courseTitle: courseTitle.trim(),
        courseDescription: coursePitch.trim(),
        instructorName: instructorName.trim(),
        coursePrice: coursePrice.trim(),
        brandPrimary,
        instructions: instructions || '',
      });
      console.log(`   ✓ Funnel copy generated`);

      let funnelImages = {};
      let funnelImageStats = { total: 0, failed: 0, skipped: skipImages };
      if (!skipImages && IMAGES_ENABLED) {
        try {
          console.log(`🎨 [funnel-only] Generating funnel images...`);
          const r = await generateFunnelImages({
            apiKey: GEMINI_API_KEY,
            model: GEMINI_IMAGE_MODEL,
            imageSize: GEMINI_IMAGE_SIZE,
            content: funnelContent,
            courseTitle: courseTitle.trim(),
            accent: brandPrimary,
            onProgress: ({ done, total, label }) => {
              if (done === 1 || done % 3 === 0 || done === total) {
                console.log(`   ...${done}/${total} — last: ${label}`);
              }
            },
          });
          funnelImages = r.images;
          funnelImageStats = { total: r.total, failed: r.failed };
          console.log(`   ✓ Funnel images: ${r.total - r.failed}/${r.total} succeeded`);
        } catch (e) {
          console.warn(`⚠️  Funnel image generation failed: ${e.message}`);
          funnelImageStats = { total: 9, failed: 9, error: e.message };
        }
      } else if (skipImages) {
        console.log(`   ⏭  Skipping image generation (skipImages=true). Custom values for image URLs will not be set.`);
      }

      // Load instructor photo into memory for later push
      const instructorPhotoBlob = {
        buffer: fs.readFileSync(req.file.path),
        mime: req.file.mimetype || 'image/jpeg',
        filename: req.file.originalname || `instructor-${Date.now()}.jpg`,
      };
      try { fs.unlinkSync(req.file.path); } catch (_) {}

      const draftId = randomUUID();
      drafts.set(draftId, {
        funnelOnly: true,
        input: {
          locationId,
          courseTitle: courseTitle.trim(),
          instructorName: instructorName.trim(),
          coursePrice: coursePrice.trim(),
          brandPrimary,
          brandDarkBg,
          instructions: instructions || '',
          coursePitch: coursePitch.trim(),
          accent: brandPrimary,   // used by existing GET /api/draft for compat
        },
        funnelContent,
        funnelImages,
        funnelImageStats,
        instructorPhoto: instructorPhotoBlob,
        generatedAt: Date.now(),
      });

      res.json({
        draftId,
        funnel: {
          generated: true,
          content: funnelContent,
          imageStats: funnelImageStats,
          imageKeys: Object.keys(funnelImages),
        },
      });
    } catch (err) {
      console.error('Funnel-only generate error:', err);
      const friendly = humanizeAiError(err);
      res.status(500).json({ error: friendly, raw: err.message });
    }
  }
);

app.post('/api/funnel-only/regenerate/:draftId', async (req, res) => {
  try {
    const draft = drafts.get(req.params.draftId);
    if (!draft || !draft.funnelOnly) return res.status(404).json({ error: 'Funnel-only draft not found' });
    const i = draft.input;

    const regenInfo = getRegenInfo(i.locationId);
    if (regenInfo.remaining <= 0) {
      return res.status(403).json({ error: `Regen limit reached for sub-account (${regenInfo.used}/${regenInfo.limit})` });
    }

    console.log(`📝 [funnel-only] Regenerating funnel for "${i.courseTitle}"...`);
    const newContent = await generateFunnelContent({
      apiKey: GEMINI_API_KEY,
      model: GEMINI_TEXT_MODEL,
      courseTitle: i.courseTitle,
      courseDescription: i.coursePitch,
      instructorName: i.instructorName,
      coursePrice: i.coursePrice,
      brandPrimary: i.brandPrimary,
      instructions: i.instructions || '',
    });

    let newImages = {};
    let newImageStats = draft.funnelImageStats?.skipped
      ? { total: 0, failed: 0, skipped: true }
      : { total: 0, failed: 0 };
    if (!draft.funnelImageStats?.skipped && IMAGES_ENABLED) {
      try {
        const r = await generateFunnelImages({
          apiKey: GEMINI_API_KEY,
          model: GEMINI_IMAGE_MODEL,
          imageSize: GEMINI_IMAGE_SIZE,
          content: newContent,
          courseTitle: i.courseTitle,
          accent: i.brandPrimary,
        });
        newImages = r.images;
        newImageStats = { total: r.total, failed: r.failed };
      } catch (e) {
        console.warn(`⚠️  Funnel image regen failed: ${e.message}`);
        newImageStats = { total: 9, failed: 9, error: e.message };
      }
    }

    draft.funnelContent = newContent;
    draft.funnelImages = newImages;
    draft.funnelImageStats = newImageStats;
    drafts.set(req.params.draftId, draft);

    const regen = bumpRegen(i.locationId);
    res.json({
      regen,
      funnel: {
        generated: true,
        content: newContent,
        imageStats: newImageStats,
        imageKeys: Object.keys(newImages),
      },
    });
  } catch (err) {
    console.error('Funnel-only regenerate error:', err);
    res.status(500).json({ error: humanizeAiError(err), raw: err.message });
  }
});

app.post('/api/funnel-only/push/:draftId', async (req, res) => {
  // Streaming response setup
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const emit = (event) => { try { res.write(JSON.stringify(event) + '\n'); } catch {} };

  try {
    const draft = drafts.get(req.params.draftId);
    if (!draft || !draft.funnelOnly || !draft.funnelContent) {
      emit({ phase: 'error', error: 'Funnel-only draft not found or missing content' });
      return res.end();
    }
    const locationId = draft.input.locationId;
    emit({ phase: 'start', locationId, mode: 'funnel-only' });

    // Resolve auth
    let authToken;
    try {
      const r = await resolveTokenForLocation(locationId);
      authToken = r.token;
      console.log(`🔐 [funnel-only] Auth source for ${locationId}: ${r.source}`);
      emit({ phase: 'auth', status: 'done', source: r.source });
    } catch (e) {
      emit({ phase: 'error', error: `Cannot authenticate to sub-account ${locationId}: ${e.message}` });
      return res.end();
    }

    // ────────────────────────────────────────────────────────────────
    // STEP A — Apply the chosen theme's funnel template to the sub-account.
    // Uses GHL's "clone funnel to locations" share endpoint (the same path
    // the UI uses when you click "Share Funnel → Import to Sub-Account").
    // This replaces the older snapshot-load approach, which produced funnels
    // with missing elements (page-builder widgets, custom HTML blocks, etc.).
    // The share-clone path is bit-perfect.
    //
    // Auth: User JWT only — the endpoint doesn't require token-id (unlike
    // snapshot-load). If the JWT is missing/expired, the rest of the push
    // still continues so customValues + images can be retried on a fresh
    // push, and any existing themed funnel in the sub-account stays valid.
    // ────────────────────────────────────────────────────────────────
    const themeKey = isValidTheme(draft.input.theme) ? draft.input.theme : DEFAULT_THEME;
    const theme = getTheme(themeKey);
    const cloneFunnelName = `Content Generation Studio Funnel (${theme.name}-Theme)`;
    emit({ phase: 'theme-snapshot', status: 'start', theme: themeKey, funnelId: theme.funnelId });
    try {
      if (!theme.funnelId) {
        throw new Error(`Theme "${themeKey}" has no funnelId mapped in lib/funnel-themes.js. Update it or pass a different theme.`);
      }
      const userAuth = await getActiveUserJwt();
      if (!userAuth?.jwt) {
        throw new Error('No User JWT available — paste one at /setup or open CC360 in a tab so the snippet syncs one.');
      }
      const cloneResult = await cloneFunnelToLocations({
        funnelId: theme.funnelId,
        funnelName: cloneFunnelName,
        targetLocationIds: locationId,
        userJwt: userAuth.jwt,
        tokenId: userAuth.tokenId,
      });
      console.log(`   ✓ Funnel ${theme.funnelId} (${themeKey}) cloned to ${locationId} as "${cloneFunnelName}"; traceId=${cloneResult.traceId || '?'}`);
      emit({ phase: 'theme-snapshot', status: 'propagating' });
      await waitForCloneVisibility(4000);
      emit({ phase: 'theme-snapshot', status: 'done', theme: themeKey, funnelName: cloneFunnelName });
    } catch (e) {
      console.warn(`   ⚠ Funnel clone failed (continuing with values push): ${e.message}`);
      emit({ phase: 'theme-snapshot', status: 'failed', error: e.message, note: 'Continuing — existing themed funnel in this sub-account will still receive updated content via customValues' });
    }

    // Upload instructor photo
    let instructorPhotoUrl = null;
    if (draft.instructorPhoto?.buffer) {
      emit({ phase: 'funnel-photo', status: 'start' });
      try {
        instructorPhotoUrl = await uploadInstructorPhoto({
          token: authToken,
          locationId,
          buffer: draft.instructorPhoto.buffer,
          filename: `instructor-${slug(draft.input.instructorName, 30)}-${Date.now()}.jpg`,
          mimeType: draft.instructorPhoto.mime || 'image/jpeg',
        });
        console.log(`   ✓ Instructor photo → ${instructorPhotoUrl}`);
        emit({ phase: 'funnel-photo', status: 'done', url: instructorPhotoUrl });
      } catch (e) {
        console.warn(`   ✗ Instructor photo upload failed: ${e.message}`);
        emit({ phase: 'funnel-photo', status: 'failed', error: e.message });
      }
    }

    // Upload funnel images (may be empty if skipImages was on at generate time)
    let funnelImageUrls = {};
    if (draft.funnelImages && Object.keys(draft.funnelImages).length > 0) {
      const totalImages = Object.keys(draft.funnelImages).length;
      emit({ phase: 'funnel-images', status: 'start', total: totalImages });
      try {
        const r = await uploadFunnelImages({
          token: authToken,
          locationId,
          imageMap: draft.funnelImages,
          coursePrefix: draft.input.courseTitle,
        });
        funnelImageUrls = r.urls;
        console.log(`   ✓ Funnel images: ${Object.keys(r.urls).length}/${totalImages} uploaded`);
        emit({ phase: 'funnel-images', status: 'done', uploaded: Object.keys(r.urls).length, failed: r.failed.length });
      } catch (e) {
        console.warn(`   ✗ Funnel image upload failed: ${e.message}`);
        emit({ phase: 'funnel-images', status: 'failed', error: e.message });
      }
    } else {
      // No images to upload (skipped at generate) — emit a done event so the UI shows it as completed
      emit({ phase: 'funnel-images', status: 'done', uploaded: 0, failed: 0, skipped: true });
    }

    // Build the value map and push
    const valueMap = flattenToCustomValueMap(draft.funnelContent, {
      coursePrice: draft.input.coursePrice,
      footerYear: new Date().getFullYear(),
    });
    valueMap.instructor_name = draft.input.instructorName;
    // Note: brand_primary / brand_dark_bg / section bg custom values are NOT
    // written — the themed funnel template owns those colors and backgrounds.
    if (instructorPhotoUrl) valueMap.instructor_photo_url = instructorPhotoUrl;
    for (let i = 1; i <= 8; i++) {
      const k = `module_${i}`;
      if (funnelImageUrls[k]) valueMap[`module_${i}_image_url`] = funnelImageUrls[k];
    }
    if (funnelImageUrls.pricing_laptop) valueMap.pricing_laptop_image = funnelImageUrls.pricing_laptop;
    // Inside-card icons (6 — for "What You Will Get in This Course")
    for (let i = 1; i <= 6; i++) {
      const k = `inside_card_${i}_icon`;
      if (funnelImageUrls[k]) valueMap[`inside_card_${i}_icon_url`] = funnelImageUrls[k];
    }

    emit({ phase: 'funnel-customvalues', status: 'start', total: Object.keys(valueMap).length });
    let cvResult;
    try {
      cvResult = await pushCustomValues({ token: authToken, locationId, valueMap });
      console.log(`   ✓ Custom values: updated=${cvResult.updated.length}, created=${cvResult.created.length}, failed=${cvResult.failed.length}`);
      emit({
        phase: 'funnel-customvalues',
        status: 'done',
        updated: cvResult.updated.length,
        created: cvResult.created.length,
        failed: cvResult.failed.length,
        failures: cvResult.failed,
      });
    } catch (e) {
      console.warn(`   ✗ Custom values push failed: ${e.message}`);
      emit({ phase: 'funnel-customvalues', status: 'failed', error: e.message });
      cvResult = { updated: [], created: [], failed: [] };
    }

    draft.funnelPushResult = {
      instructorPhotoUrl,
      funnelImageUrls,
      customValues: {
        updated: cvResult.updated.length,
        created: cvResult.created.length,
        failed: cvResult.failed.length,
        failures: cvResult.failed,
      },
    };
    draft.pushedAt = Date.now();
    drafts.set(req.params.draftId, draft);

    emit({ phase: 'done', funnel: draft.funnelPushResult });
    res.end();
  } catch (err) {
    console.error('Funnel-only push error:', err);
    emit({ phase: 'error', error: err.message || 'Push failed', details: err.response?.data });
    res.end();
  }
});

app.get('/setup', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------
app.listen(PORT, async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' Content Generation Studio is running');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` Open builder:      http://localhost:${PORT}`);
  console.log(` Open setup:        http://localhost:${PORT}/setup`);
  console.log(` Sub-account:       supplied per request via the form`);
  if (CC360_LOCATION_ID) {
    console.log(` Default fallback:  ${CC360_LOCATION_ID} (used if form leaves field empty)`);
  }
  console.log(` Regen limit:       ${REGEN_LIMIT} per sub-account`);
  if (oauthConfigured) {
    let installs = [];
    try {
      installs = await tokenStore.listInstallations();
    } catch (e) {
      console.error(`⚠️  Could not read installs at boot (token store unavailable): ${e.message}`);
    }
    const subAccts = installs.filter(i => i.kind !== 'company' && i.kind !== 'user-jwt');
    const companies = installs.filter(i => i.kind === 'company');
    console.log(` Auth:              ✅ OAuth (Sub-Account Marketplace App)`);
    console.log(`                    Client ID: ${GHL_CLIENT_ID.slice(0, 20)}...`);
    console.log(`                    Redirect:  ${GHL_OAUTH_REDIRECT_URI}`);
    console.log(`                    Storage:   ${tokenStoreBackend()}${tokenStoreBackend() === 'postgres' ? ' ✅ persistent' : ' ⚠️  volatile (wiped on redeploy)'}`);
    console.log(`                    Installs:  ${subAccts.length} sub-account${subAccts.length === 1 ? '' : 's'}, ${companies.length} agency-level`);
    if (CC360_JWT) console.log(`                    (CC360_JWT PIT also set as fallback)`);
  } else if (CC360_JWT) {
    console.log(` Auth:              ⚠️  PIT only (legacy single-account mode)`);
    console.log(`                    For multi-tenant use, set GHL_CLIENT_ID / SECRET / REDIRECT_URI and visit /setup`);
  }
  console.log(` Text AI:           Gemini (${GEMINI_TEXT_MODEL})`);
  if (IMAGES_ENABLED) {
    console.log(` Image AI:          Gemini (${GEMINI_IMAGE_MODEL}, size=${GEMINI_IMAGE_SIZE}) — requires a PAID Gemini project`);
  } else {
    console.log(` Image AI:          ⚠️  OFF (AI_IMAGES=off) — courses/funnels build without thumbnails`);
  }
  console.log(` Backend JWT:       paste at /setup → "User JWT for thumbnail attach" (Postgres-persisted)${CC360_USER_JWT ? ' · CC360_USER_JWT env override is set' : ''}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

function decodeJwtExp(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return payload.exp ? Math.round(payload.exp * 1000) : null;
  } catch { return null; }
}