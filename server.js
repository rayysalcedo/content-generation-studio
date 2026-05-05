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
import { renderLessonHTML, buildTheme } from './lib/render-html.js';
import { renderWorkbookPdf } from './lib/pdf-renderer.js';
import { uploadToMediaLibrary } from './lib/upload-media.js';
import { importCourse } from './lib/cc360.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  CC360_JWT,                                  // PIT for the test sub-account
  CC360_LOCATION_ID,
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-2.0-flash',
  PORT = 3000,
  REGEN_LIMIT = 3,                            // max regenerations per sub-account
} = process.env;

// Default course size when user leaves the count fields empty (auto mode)
const DEFAULT_MODULE_COUNT = 5;
const DEFAULT_LESSONS_PER_MODULE = 5;

if (!CC360_JWT || !CC360_LOCATION_ID || !GEMINI_API_KEY) {
  console.error('❌ Missing env vars in .env. Required: CC360_JWT (PIT), CC360_LOCATION_ID, GEMINI_API_KEY');
  process.exit(1);
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
      apiKey: GEMINI_API_KEY,
      model: GEMINI_MODEL,
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
        apiKey: GEMINI_API_KEY,
        model: GEMINI_MODEL,
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

    const draftId = randomUUID();
    drafts.set(draftId, {
      input: {
        mode, courseTitle, targetAudience, instructions, description,
        moduleCount: resolvedModuleCount,
        lessonsPerModule: resolvedLessonsPerModule,
        accent: accent || '#6366f1',
        sourceText,
        generateWorkbooks: wantWorkbooks,
      },
      structure,
      generatedAt: Date.now(),
      workbookStats,
    });

    res.json({
      draftId,
      structure,
      regen: getRegenInfo(CC360_LOCATION_ID),
      workbookStats,
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
    return 'Gemini AI is currently overloaded (Google\'s servers are busy). Please wait a minute and try again. If this keeps happening, try changing GEMINI_MODEL in .env to gemini-1.5-flash or gemini-1.5-pro.';
  }
  if (/\b429\b|rate limit/i.test(msg)) {
    return 'Hit the Gemini rate limit. Wait 30 seconds and try again.';
  }
  if (/\b401\b|api key|unauthorized/i.test(msg)) {
    return 'Gemini rejected the API key. Check GEMINI_API_KEY in .env.';
  }
  if (/\b400\b|invalid argument/i.test(msg)) {
    return 'Gemini rejected the prompt. Try a shorter source PDF or simpler description.';
  }
  if (/timeout|timed.out|deadline/i.test(msg)) {
    return 'Gemini took too long to respond. Try a smaller course (fewer modules/lessons) or a shorter PDF.';
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

    const info = getRegenInfo(CC360_LOCATION_ID);
    if (info.remaining <= 0) {
      return res.status(429).json({
        error: `Regenerate limit reached (${info.limit}/${info.limit}). Edit manually instead, or push as-is.`,
        regen: info,
      });
    }

    const i = draft.input;
    const structure = await generateCourseStructure({
      apiKey: GEMINI_API_KEY,
      model: GEMINI_MODEL,
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
        model: GEMINI_MODEL,
        structure,
      });
      workbookStats = { total: r.total, failed: r.failed };
    }

    draft.structure = structure;
    draft.generatedAt = Date.now();
    draft.workbookStats = workbookStats;
    drafts.set(draftId, draft);

    const newInfo = bumpRegen(CC360_LOCATION_ID);
    res.json({ draftId, structure, regen: newInfo, workbookStats });
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
  // Wire the preview button to the actual PDF endpoint when we have draft coordinates.
  // After push to CC360, this gets replaced with the real media library URL.
  const opts = (withWorkbook && lesson.workbook && draftId !== undefined && mi !== undefined && li !== undefined)
    ? { workbookUrl: `/api/preview-pdf/${draftId}/${mi}/${li}` }
    : {};
  res.json({ html: renderLessonHTML(lesson, theme, opts) });
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
    const workbookUrlByLessonKey = {};
    const uploadResults = [];   // for response

    // 1. For each lesson with workbook content, render PDF + upload to media library
    const modules = draft.structure.modules || [];
    let totalToUpload = 0;
    modules.forEach(m => (m.lessons || []).forEach(l => { if (l.workbook) totalToUpload++; }));

    if (totalToUpload > 0) {
      console.log(`📤 Pushing course "${draft.structure.courseTitle}" — uploading ${totalToUpload} workbook PDFs...`);
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
            pit: CC360_JWT,
            locationId: CC360_LOCATION_ID,
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

    // 2. Import the course with workbook URLs threaded into lesson HTML
    console.log(`📚 Importing course to CC360...`);
    const result = await importCourse({
      pit: CC360_JWT,
      locationId: CC360_LOCATION_ID,
      draft: draft.structure,
      accent,
      workbookUrlByLessonKey,
    });
    console.log(`   ✓ Course created: ${result.url}`);

    draft.pushedAt = Date.now();
    draft.cc360 = result;
    draft.uploadResults = uploadResults;
    drafts.set(draftId, draft);

    res.json({
      ...result,
      workbooks: {
        total: totalToUpload,
        succeeded: uploadResults.filter(r => r.ok).length,
        failed: uploadResults.filter(r => !r.ok).length,
        results: uploadResults,
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
  res.json({
    draftId: req.params.draftId,
    structure: draft.structure,
    accent: draft.input.accent,
    regen: getRegenInfo(CC360_LOCATION_ID),
    pushedAt: draft.pushedAt || null,
    cc360: draft.cc360 || null,
    workbookStats: draft.workbookStats || null,
    uploadResults: draft.uploadResults || null,
  });
});

// ---------------------------------------------------------------------
// API: Misc
// ---------------------------------------------------------------------
app.get('/api/config', (_req, res) => {
  res.json({
    locationId: CC360_LOCATION_ID,
    regen: getRegenInfo(CC360_LOCATION_ID),
    regenLimit: Number(REGEN_LIMIT),
  });
});

// ---------------------------------------------------------------------
// Routing for HTML pages
// ---------------------------------------------------------------------
app.get('/preview/:draftId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview.html'));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------
app.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' CC360 Course Studio is running');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` Open in browser:   http://localhost:${PORT}`);
  console.log(` Sub-account:       ${CC360_LOCATION_ID}`);
  console.log(` Regen limit:       ${REGEN_LIMIT} per sub-account`);
  console.log(` Auth:              ${CC360_JWT.startsWith('pit-') ? '✅ Private Integration Token' : '⚠️  Not a PIT'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});