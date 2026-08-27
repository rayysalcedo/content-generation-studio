// lib/generate-workbook.js — Generate AI workbook content (questions, action items, reflection)
// for each lesson in a course structure, using Gemini (Interactions API) in JSON mode.
//
import { generateJsonText } from './gemini.js';
import { retryAi, isTransient } from './retry.js';

// Workbooks use a text model (not image). Gemini text rate limits are generous
// on paid tiers; on the free tier lower this to 2-3 to avoid 429s.
// Override via env if you ever hit 429s:
//   AI_WORKBOOK_CONCURRENCY=10  AI_WORKBOOK_DELAY_MS=200
const BATCH_SIZE     = Number(process.env.AI_WORKBOOK_CONCURRENCY) || 6;
const BATCH_DELAY_MS = Number(process.env.AI_WORKBOOK_DELAY_MS)    || 400;

/**
 * Augment every lesson in `structure.modules[].lessons[]` with a `.workbook` field.
 * Mutates the structure in-place AND returns it.
 *
 * The workbook field shape:
 *   { questions: string[], actionItems: string[], reflection: string }
 *
 * If a lesson's workbook generation fails after retries, that lesson gets no workbook
 * (it just won't show a download button when pushed). We don't fail the whole job.
 */
export async function generateWorkbooksForCourse({
  apiKey,
  model = 'gemini-3.7-flash',
  structure,
  onProgress = () => {},
}) {

  // Flatten lessons into a queue with location pointers so we can write back
  const queue = [];
  (structure.modules || []).forEach((mod, mi) => {
    (mod.lessons || []).forEach((lesson, li) => {
      queue.push({ mi, li, lesson, courseTitle: structure.courseTitle, moduleTitle: mod.title });
    });
  });

  const total = queue.length;
  let done = 0;
  let failed = 0;

  // Process in batches with a short delay between batches to respect rate limits
  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const batch = queue.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(item => generateOneWorkbook(apiKey, item, model).catch(err => {
        console.warn(`⚠️  Workbook gen failed for "${item.lesson.title}": ${err.message}`);
        return null;
      }))
    );
    results.forEach((wb, idx) => {
      const { mi, li } = batch[idx];
      if (wb) {
        structure.modules[mi].lessons[li].workbook = wb;
      } else {
        failed++;
      }
      done++;
      onProgress({ done, total, failed });
    });

    // Throttle between batches (skip delay after the very last batch)
    const hasMoreBatches = i + BATCH_SIZE < queue.length;
    if (hasMoreBatches) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }
  return { structure, total, failed };
}

async function generateOneWorkbook(apiKey, { lesson, courseTitle, moduleTitle }, model) {
  return await retryAi(async () => {
    const prompt = buildWorkbookPrompt({ lesson, courseTitle, moduleTitle });
    const responseText = await generateJsonText({ apiKey, model, prompt, maxOutputTokens: 4000 });
    const parsed = safeParseJson(responseText);
    validateWorkbook(parsed);
    return parsed;
  }, {
    label: `Workbook for "${lesson.title}"`,
    maxAttempts: 4,
    // Retry on transient errors AND on parse/validation errors (model sometimes returns bad JSON)
    shouldRetry: (err) => {
      if (isTransient(err)) return true;
      const msg = String(err.message || '').toLowerCase();
      if (msg.includes('json parse') || msg.includes('parse failed')) return true;
      if (msg.includes('missing') || msg.includes('too few')) return true;
      return false;
    },
  });
}

function buildWorkbookPrompt({ lesson, courseTitle, moduleTitle }) {
  // Compress the lesson into a learnable summary the AI can write exercises against
  const sectionText = (lesson.sections || [])
    .map(s => `${s.heading || ''}: ${stripTags(s.body || '')}`)
    .join('\n');
  const takeawayText = (lesson.keyTakeaways || []).map(t => `- ${t}`).join('\n');

  return `You are creating a downloadable PRINTABLE WORKBOOK that accompanies a course lesson. The workbook helps the learner apply, reflect on, and internalize what they just learned.

Output ONLY a single valid JSON object with this EXACT shape:

{
  "questions": [
    "3 to 4 open-ended workbook questions that test understanding and application of THIS lesson's concepts.",
    "Each question should require thoughtful written response (not yes/no).",
    "Tied directly to lesson content — not generic."
  ],
  "actionItems": [
    "3 to 5 concrete, specific action items the learner can DO this week.",
    "Each phrased as an actionable task ('Track your...', 'Schedule a...', 'Practice...').",
    "Tangible — checkable as done/not-done."
  ],
  "reflection": "ONE thoughtful reflection prompt (2-3 sentences max) that helps the learner connect this lesson to their own life or experience. Not just a question — a prompt that invites real reflection."
}

CRITICAL RULES:
- Questions must be 3 or 4 items, each ending with a question mark.
- Action items must be 3 to 5 items, each starting with a verb.
- Reflection is a SINGLE string, not an array.
- Use ONLY straight ASCII double quotes (").
- No markdown, no commentary, no code fences — just the JSON object.

Course Title: ${courseTitle}
Module: ${moduleTitle}
Lesson Title: ${lesson.title}
Lesson Summary: ${lesson.summary || ''}

Key Takeaways:
${takeawayText}

Lesson Content:
${sectionText}
`;
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '');
}

function validateWorkbook(wb) {
  if (!wb || typeof wb !== 'object') throw new Error('not an object');
  if (!Array.isArray(wb.questions) || wb.questions.length < 2) throw new Error('questions missing or too few');
  if (!Array.isArray(wb.actionItems) || wb.actionItems.length < 2) throw new Error('actionItems missing or too few');
  if (typeof wb.reflection !== 'string' || !wb.reflection.trim()) throw new Error('reflection missing');
  wb.questions = wb.questions.map(q => String(q).trim()).filter(Boolean);
  wb.actionItems = wb.actionItems.map(a => String(a).trim()).filter(Boolean);
  wb.reflection = wb.reflection.trim();
}

function safeParseJson(raw) {
  let text = (raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(text); } catch (_) {}
  const cleaned = text
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(cleaned); } catch (e) {
    throw new Error(`workbook JSON parse failed: ${e.message}`);
  }
}