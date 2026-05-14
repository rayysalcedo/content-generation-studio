// server.js — CC360 Course Studio (local web app)
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
import { uploadToMediaLibrary } from './lib/upload-media.js';
import { importCourse, attachThumbnails } from './lib/cc360.js';
import {
  buildAuthorizeUrl, exchangeCodeForToken, getValidTokenForLocation,
  newState, consumeState,
} from './lib/oauth.js';
import { store as tokenStore, backendName as tokenStoreBackend } from './lib/token-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  CC360_JWT,                                  // Legacy PIT fallback (single-account use)
  CC360_USER_JWT,                             // User-session JWT for INTERNAL backend.* API (thumbnail attach only)
  CC360_LOCATION_ID,                          // Optional fallback (used by CLI / when form leaves it empty)
  OPENAI_API_KEY,                             // The one and only AI provider key now
  OPENAI_TEXT_MODEL = 'gpt-5.4-mini',         // Course structure + workbook generation
  OPENAI_IMAGE_MODEL = 'gpt-image-1-mini',    // Thumbnail generation
  OPENAI_IMAGE_QUALITY = 'medium',            // 'low' | 'medium' | 'high'
  GHL_CLIENT_ID,                              // OAuth: Sub-Account Marketplace App client ID
  GHL_CLIENT_SECRET,                          // OAuth: Sub-Account Marketplace App client secret
  GHL_OAUTH_REDIRECT_URI,                     // OAuth: e.g. https://your-app.onrender.com/oauth/callback
  GHL_OAUTH_SCOPES = 'medias.readonly medias.write courses.readonly courses.write locations.readonly',
  PORT = 3000,
  REGEN_LIMIT = 3,                            // max regenerations per sub-account
} = process.env;

// Default course size when user leaves the count fields empty (auto mode)
const DEFAULT_MODULE_COUNT = 5;
const DEFAULT_LESSONS_PER_MODULE = 5;

if (!OPENAI_API_KEY) {
  console.error('❌ Missing required env var: OPENAI_API_KEY');
  process.exit(1);
}
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
    try {
      const token = await getValidTokenForLocation({
        store: tokenStore,
        clientId: GHL_CLIENT_ID,
        clientSecret: GHL_CLIENT_SECRET,
        locationId,
      });
      return { token, source: 'oauth' };
    } catch (e) {
      if (CC360_JWT) {
        console.warn(`⚠️  OAuth resolve failed for ${locationId}: ${e.message}. Falling back to PIT.`);
        return { token: CC360_JWT, source: 'pit-fallback' };
      }
      throw e;
    }
  }
  if (CC360_JWT) return { token: CC360_JWT, source: 'pit' };
  throw new Error('No auth source available. Install the app for this sub-account at /setup, or set CC360_JWT.');
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
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 25 * 1024 * 1024 },     // 25 MB cap
});

// ---------------------------------------------------------------------
// API: Generate a new draft
// ---------------------------------------------------------------------
app.post('/api/generate', upload.single('pdf'), async (req, res) => {
  try {
    const { mode, courseTitle, targetAudience, instructions, description, moduleCount, lessonsPerModule, accent, generateWorkbooks } = req.body;

    // Resolve & validate the target sub-account
    const locationId = pickLocationId(req.body.locationId);
    if (!locationId) {
      return res.status(400).json({ error: 'Sub-account Location ID is required' });
    }
    if (!isValidLocationId(locationId)) {
      return res.status(400).json({ error: 'Sub-account Location ID looks malformed (expected ~20 alphanumeric characters)' });
    }

    if (!mode || !courseTitle) {
      return res.status(400).json({ error: 'mode and courseTitle are required' });
    }

    let sourceText;
    if (mode === 'pdf') {
      if (!req.file) return res.status(400).json({ error: 'PDF file is required for PDF mode' });
      const { text } = await extractPdfText(req.file.path);
      sourceText = text;
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      if (sourceText.length < 50) {
        return res.status(400).json({ error: 'PDF text is too short. Is it scanned/image-based? OCR not supported.' });
      }
    } else if (mode === 'description') {
      if (!description || description.trim().length < 20) {
        return res.status(400).json({ error: 'Course description must be at least 20 characters' });
      }
      sourceText = description.trim();
    } else {
      return res.status(400).json({ error: `Unknown mode: ${mode}` });
    }

    // Resolve course size — apply defaults when user left fields empty
    const resolvedModuleCount = resolveCount(moduleCount, DEFAULT_MODULE_COUNT);
    const resolvedLessonsPerModule = resolveCount(lessonsPerModule, DEFAULT_LESSONS_PER_MODULE);

    // 1. Generate course structure (existing)
    console.log(`📚 Generating course structure for "${courseTitle}" (${resolvedModuleCount} × ${resolvedLessonsPerModule})...`);
    const structure = await generateCourseStructure({
      apiKey: OPENAI_API_KEY,
      model: OPENAI_TEXT_MODEL,
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

    // 2. Generate workbook content (NEW) — only if user hasn't disabled it
    const wantWorkbooks = generateWorkbooks !== 'false' && generateWorkbooks !== false;
    let workbookStats = { total: 0, failed: 0 };
    if (wantWorkbooks && totalLessons > 0) {
      console.log(`📝 Generating workbook content for ${totalLessons} lessons (parallel batches)...`);
      const r = await generateWorkbooksForCourse({
        apiKey: OPENAI_API_KEY,
        model: OPENAI_TEXT_MODEL,
        structure,
        onProgress: ({ done, total, failed }) => {
          // Throttle log noise — log every 5
          if (done % 5 === 0 || done === total) {
            console.log(`   ...${done}/${total} done${failed ? ` (${failed} failed)` : ''}`);
          }
        },
      });
      workbookStats = { total: r.total, failed: r.failed };
      console.log(`   ✓ Workbooks: ${r.total - r.failed}/${r.total} succeeded`);
    } else {
      console.log(`   (workbook generation skipped)`);
    }

    // 3. Generate AI cartoon thumbnails (course hero + lesson icons) — toggleable
    const wantThumbnails = req.body.generateThumbnails !== 'false' && req.body.generateThumbnails !== false;
    let thumbnailStats = { total: 0, failed: 0 };
    let thumbnails = {};                 // { course: b64, "m0-l0": b64, ... }
    if (wantThumbnails && totalLessons > 0) {
      if (!OPENAI_API_KEY) {
        console.warn(`⚠️  Thumbnails requested but OPENAI_API_KEY is not set — skipping.`);
        thumbnailStats = { total: totalLessons + 1, failed: totalLessons + 1, error: 'OPENAI_API_KEY not configured' };
      } else {
        console.log(`🎨 Generating ${totalLessons + 1} AI thumbnails via OpenAI (${OPENAI_IMAGE_MODEL}, ${OPENAI_IMAGE_QUALITY})...`);
        try {
          const r = await generateThumbnailsForCourse({
            apiKey: OPENAI_API_KEY,
            model: OPENAI_IMAGE_MODEL,
            quality: OPENAI_IMAGE_QUALITY,
            structure,
            accent: accent || '#6366f1',
            targetAudience: targetAudience || '',
            onProgress: ({ done, total, failed, label }) => {
              if (done % 5 === 0 || done === total) {
                console.log(`   ...${done}/${total} done${failed ? ` (${failed} failed)` : ''} — last: ${label}`);
              }
            },
          });
          thumbnails = r.thumbnails;
          thumbnailStats = { total: r.total, failed: r.failed };
          console.log(`   ✓ Thumbnails: ${r.total - r.failed}/${r.total} succeeded`);
        } catch (e) {
          console.warn(`⚠️  Thumbnail generation block failed: ${e.message}. Continuing without thumbnails.`);
          thumbnailStats = { total: totalLessons + 1, failed: totalLessons + 1, error: e.message };
        }
      }
    } else {
      console.log(`   (thumbnail generation skipped)`);
    }

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
      },
      structure,
      thumbnails,                                     // { course: b64, "m0-l0": b64, ... }
      generatedAt: Date.now(),
      workbookStats,
      thumbnailStats,
    });

    res.json({
      draftId,
      structure,
      regen: getRegenInfo(locationId),
      workbookStats,
      thumbnailStats,
    });
  } catch (err) {
    console.error('Generate error:', err);
    const friendly = humanizeAiError(err);
    res.status(500).json({ error: friendly, raw: err.message });
  }
});

function humanizeAiError(err) {
  const msg = String(err?.message || err || '');
  if (/\b503\b|service unavailable|overloaded|high demand/i.test(msg)) {
    return 'OpenAI is currently overloaded. Please wait a minute and try again. If this keeps happening, try setting OPENAI_TEXT_MODEL to gpt-5-mini or gpt-4.1-nano in your env.';
  }
  if (/\b429\b|rate limit/i.test(msg)) {
    return 'Hit the OpenAI rate limit. Wait 30 seconds and try again. If this keeps happening, your account tier may need to be raised.';
  }
  if (/\b401\b|api key|unauthorized|invalid_api_key/i.test(msg)) {
    return 'OpenAI rejected the API key. Check OPENAI_API_KEY in your env vars.';
  }
  if (/\b400\b|invalid argument|invalid_request/i.test(msg)) {
    return 'OpenAI rejected the prompt. Try a shorter source PDF or simpler description.';
  }
  if (/timeout|timed.out|deadline/i.test(msg)) {
    return 'OpenAI took too long to respond. Try a smaller course (fewer modules/lessons) or a shorter PDF.';
  }
  if (/model.*not.*found|model_not_found/i.test(msg)) {
    return `Model "${OPENAI_TEXT_MODEL}" not available on your account. Try gpt-5.4-mini, gpt-5-mini, or gpt-4.1-mini.`;
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
      apiKey: OPENAI_API_KEY,
      model: OPENAI_TEXT_MODEL,
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
        apiKey: OPENAI_API_KEY,
        model: OPENAI_TEXT_MODEL,
        structure,
      });
      workbookStats = { total: r.total, failed: r.failed };
    }

    // Re-generate thumbnails too (if originally enabled)
    let thumbnailStats = { total: 0, failed: 0 };
    let thumbnails = {};
    if (i.generateThumbnails && OPENAI_API_KEY) {
      try {
        const r = await generateThumbnailsForCourse({
          apiKey: OPENAI_API_KEY,
          model: OPENAI_IMAGE_MODEL,
          quality: OPENAI_IMAGE_QUALITY,
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
    drafts.set(draftId, draft);

    const newInfo = bumpRegen(draftLocationId);
    res.json({ draftId, structure, regen: newInfo, workbookStats, thumbnailStats });
  } catch (err) {
    console.error('Regenerate error:', err);
    const friendly = humanizeAiError(err);
    res.status(500).json({ error: friendly, raw: err.message });
  }
});

// ---------------------------------------------------------------------
// API: Save edits to a draft
// ---------------------------------------------------------------------
app.put('/api/draft/:draftId', (req, res) => {
  const { draftId } = req.params;
  const draft = drafts.get(draftId);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });

  const { structure, accent } = req.body;
  if (structure) draft.structure = structure;
  if (accent) draft.input.accent = accent;
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
// ---------------------------------------------------------------------
app.post('/api/push/:draftId', async (req, res) => {
  try {
    const { draftId } = req.params;
    const draft = drafts.get(draftId);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    const accent = draft.input.accent || '#6366f1';
    const draftLocationId = draft.input.locationId || CC360_LOCATION_ID;
    if (!isValidLocationId(draftLocationId)) {
      return res.status(400).json({ error: 'Draft has no valid sub-account Location ID' });
    }

    // Resolve the auth token for THIS sub-account (OAuth → PIT fallback)
    let authToken;
    try {
      const r = await resolveTokenForLocation(draftLocationId);
      authToken = r.token;
      console.log(`🔐 Auth source for ${draftLocationId}: ${r.source}`);
    } catch (e) {
      return res.status(401).json({ error: `Cannot authenticate to sub-account ${draftLocationId}: ${e.message}` });
    }

    const workbookUrlByLessonKey = {};
    const thumbnailUrlByLessonKey = {};
    let courseThumbnailUrl = null;
    const uploadResults = [];   // for response

    // 0. Upload thumbnails first (course hero + each lesson icon) — independent of workbooks
    const thumbnails = draft.thumbnails || {};
    const thumbnailKeys = Object.keys(thumbnails);
    if (thumbnailKeys.length > 0) {
      console.log(`🖼️  Uploading ${thumbnailKeys.length} thumbnails to media library...`);
      for (const key of thumbnailKeys) {
        const b64 = thumbnails[key];
        if (!b64) continue;
        try {
          const buf = base64ToBuffer(b64);
          const filename = key === 'course'
            ? `${slug(draft.structure.courseTitle, 40)}-cover.png`
            : `${slug(draft.structure.courseTitle, 30)}-${key}-thumb.png`;
          const { url } = await uploadToMediaLibrary({
            pit: authToken,
            locationId: draftLocationId,
            buffer: buf,
            filename,
            contentType: 'image/png',
          });
          if (key === 'course') {
            courseThumbnailUrl = url;
          } else {
            thumbnailUrlByLessonKey[key] = url;
          }
          uploadResults.push({ key: `thumb:${key}`, url, ok: true });
          console.log(`   ✓ Thumbnail [${key}]`);
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
    if (courseThumbnailUrl || Object.keys(thumbnailUrlByLessonKey).length > 0) {
      console.log(`   (posterImage fields included in import payload — open the course in CC360 to verify they took effect)`);
    }

    // 3. Optional fallback: attach thumbnails via the internal backend API.
    // Only runs if CC360_USER_JWT is set (the import-level posterImage approach is preferred).
    let thumbnailAttachResults = null;
    const hasThumbnailsToAttach = courseThumbnailUrl || Object.keys(thumbnailUrlByLessonKey).length > 0;
    if (hasThumbnailsToAttach && CC360_USER_JWT) {
      console.log(`🖼️  Running fallback thumbnail attach (CC360_USER_JWT is set)...`);
      try {
        thumbnailAttachResults = await attachThumbnails({
          token: authToken,
          backendToken: CC360_USER_JWT,
          locationId: draftLocationId,
          productId: result.id,
          courseTitle: draft.structure.courseTitle,
          courseDescription: draft.structure.courseDescription || `Course built on ${new Date().toLocaleDateString()}`,
          courseThumbnailUrl,
          lessonThumbnailMap: thumbnailUrlByLessonKey,
          onProgress: (p) => {
            if (p.phase === 'polling') {
              console.log(`   ⏳ waiting for lessons... (${p.totalPosts}/${p.expected})`);
            } else if (p.phase === 'polling-retry') {
              console.log(`   ⏳ poll attempt failed (will retry): ${p.error}`);
            } else if (p.phase === 'course-attached') {
              console.log(`   ✓ Course thumbnail attached (fallback)`);
            } else if (p.phase === 'course-failed') {
              console.warn(`   ✗ Course thumbnail attach failed: ${JSON.stringify(p.error)}`);
            } else if (p.phase === 'lessons-done') {
              console.log(`   ✓ Lesson thumbnails: ${p.ok}/${p.total} attached (fallback)`);
            }
          },
        });
      } catch (e) {
        console.warn(`⚠️  Fallback attach failed: ${e.message}`);
        thumbnailAttachResults = { error: e.message };
      }
    }

    draft.pushedAt = Date.now();
    draft.cc360 = result;
    draft.uploadResults = uploadResults;
    draft.courseThumbnailUrl = courseThumbnailUrl;
    draft.thumbnailAttachResults = thumbnailAttachResults;
    drafts.set(draftId, draft);

    res.json({
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
    });
  } catch (err) {
    console.error('Push error:', err);
    const responseData = err.response?.data;
    res.status(500).json({
      error: err.message || 'Push failed',
      details: responseData,
    });
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
    const stateData = consumeState(state);
    if (!stateData) {
      return res.redirect(`/setup?error=${encodeURIComponent('Invalid or expired state. Please try installing again.')}`);
    }

    const tokenData = await exchangeCodeForToken({
      code,
      clientId: GHL_CLIENT_ID,
      clientSecret: GHL_CLIENT_SECRET,
      userType: 'Location',
      redirectUri: GHL_OAUTH_REDIRECT_URI,
    });

    const locationId = tokenData.locationId;
    if (!locationId) {
      return res.redirect(`/setup?error=${encodeURIComponent('Token exchange succeeded but no locationId returned. Make sure your app Target User is Sub-Account.')}`);
    }

    await tokenStore.saveInstallation({
      locationId,
      companyId: tokenData.companyId || null,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + ((tokenData.expires_in || 86400) * 1000),
      scopes: tokenData.scope || GHL_OAUTH_SCOPES,
      installedAt: Date.now(),
      locationName: tokenData.locationName || null,
      companyName: tokenData.companyName || null,
    });

    console.log(`✅ OAuth install: sub-account ${locationId} (${tokenData.locationName || 'unknown name'})`);
    res.redirect(`${stateData.returnTo || '/setup'}?installed=1`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`/setup?error=${encodeURIComponent(err.message)}`);
  }
});

app.get('/api/installations', async (_req, res) => {
  try {
    const list = await tokenStore.listInstallations();
    const installations = list.map(i => ({
      locationId: i.locationId,
      locationName: i.locationName,
      companyId: i.companyId,
      companyName: i.companyName,
      installedAt: i.installedAt,
      expiresAt: i.expiresAt,
      scopes: i.scopes,
    }));
    res.json({ installations, oauthConfigured });
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
// Routing for HTML pages
// ---------------------------------------------------------------------
app.get('/preview/:draftId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview.html'));
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
  console.log(' CC360 Course Studio is running (multi-tenant)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` Open builder:      http://localhost:${PORT}`);
  console.log(` Open setup:        http://localhost:${PORT}/setup`);
  console.log(` Sub-account:       supplied per request via the form`);
  if (CC360_LOCATION_ID) {
    console.log(` Default fallback:  ${CC360_LOCATION_ID} (used if form leaves field empty)`);
  }
  console.log(` Regen limit:       ${REGEN_LIMIT} per sub-account`);
  if (oauthConfigured) {
    const installs = await tokenStore.listInstallations();
    console.log(` Auth:              ✅ OAuth (Sub-Account Marketplace App)`);
    console.log(`                    Client ID: ${GHL_CLIENT_ID.slice(0, 20)}...`);
    console.log(`                    Redirect:  ${GHL_OAUTH_REDIRECT_URI}`);
    console.log(`                    Storage:   ${tokenStoreBackend()}${tokenStoreBackend() === 'postgres' ? ' ✅ persistent' : ' ⚠️  volatile (wiped on redeploy)'}`);
    console.log(`                    Installs:  ${installs.length} sub-account${installs.length === 1 ? '' : 's'}`);
    if (CC360_JWT) console.log(`                    (CC360_JWT PIT also set as fallback)`);
  } else if (CC360_JWT) {
    console.log(` Auth:              ⚠️  PIT only (legacy single-account mode)`);
    console.log(`                    For multi-tenant use, set GHL_CLIENT_ID / SECRET / REDIRECT_URI and visit /setup`);
  }
  console.log(` Text AI:           OpenAI (${OPENAI_TEXT_MODEL})`);
  if (OPENAI_API_KEY) {
    console.log(` Image AI:          OpenAI (${OPENAI_IMAGE_MODEL}, quality=${OPENAI_IMAGE_QUALITY})`);
  } else {
    console.log(` Image AI:          ⚠️  OPENAI_API_KEY not set — thumbnails will be skipped`);
  }
  if (CC360_USER_JWT) {
    const expiry = decodeJwtExp(CC360_USER_JWT);
    if (expiry) {
      const mins = Math.round((expiry - Date.now()) / 60000);
      console.log(` Backend JWT:       ✅ set (expires ${mins > 0 ? `in ${mins} min` : `${-mins} min AGO — REFRESH IT`})`);
    } else {
      console.log(` Backend JWT:       ✅ set (couldn't parse expiry)`);
    }
  } else {
    console.log(` Backend JWT:       ⚠️  CC360_USER_JWT not set — thumbnail attach will 401 on backend.*`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

function decodeJwtExp(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return payload.exp ? Math.round(payload.exp * 1000) : null;
  } catch { return null; }
}