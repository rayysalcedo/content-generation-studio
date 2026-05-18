// lib/generate-thumbnails.js — Generate AI cartoon thumbnails (course hero + lesson icons)
// using OpenAI's Image API (gpt-image-1-mini by default).
//
// Returns base64 PNG data per image, keyed in a flat map:
//   { course: "<base64>", "m0-l0": "<base64>", "m0-l1": "<base64>", ... }
//
// The caller stores this on the draft (out-of-band from `structure`) so that editing
// the structure JSON doesn't round-trip megabytes of image data.
//
// IMPORTANT: GPT Image models require OpenAI Organization Verification before they
// will accept requests. Complete the verification form in your OpenAI developer
// console first, or every call will fail with a 403.
//
import OpenAI from 'openai';
import { retryAi, isTransient } from './retry.js';

// Defaults — overridable via env vars in server.js
const DEFAULT_MODEL = 'gpt-image-1-mini';     // cheapest sweet-spot; bump to gpt-image-1.5 or gpt-image-2 for higher quality
const DEFAULT_QUALITY = 'medium';             // 'low' | 'medium' | 'high'

// Concurrency — OpenAI image rate limits are tier-based. Tier 1 supports
// ~5 concurrent gpt-image-1 calls comfortably, Tier 2+ supports many more.
// Override via env if you hit 429s or want to push harder:
//   AI_IMAGE_CONCURRENCY=8  AI_IMAGE_DELAY_MS=200
const BATCH_SIZE     = Number(process.env.AI_IMAGE_CONCURRENCY) || 5;
const BATCH_DELAY_MS = Number(process.env.AI_IMAGE_DELAY_MS)    || 500;

// OpenAI image sizes — closest available to our desired aspects
const SIZE_LANDSCAPE = '1536x1024';   // for course hero (3:2, near-16:9)
const SIZE_SQUARE    = '1024x1024';   // for lesson icons (1:1)

/**
 * Generate course hero (landscape) + a thumbnail icon (square) per lesson.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey           - OpenAI API key
 * @param {string} [opts.model]          - override image model (defaults to gpt-image-1-mini)
 * @param {string} [opts.quality]        - 'low' | 'medium' | 'high' (default 'medium')
 * @param {Object} opts.structure        - course structure
 * @param {string} opts.accent           - brand color hex
 * @param {string} [opts.targetAudience]
 * @param {Function} [opts.onProgress]   - ({ done, total, failed, label }) => void
 * @returns {Promise<{ thumbnails: Object<string,string>, total: number, failed: number }>}
 */
export async function generateThumbnailsForCourse({
  apiKey,
  model = DEFAULT_MODEL,
  quality = DEFAULT_QUALITY,
  structure,
  accent = '#6366f1',
  targetAudience = '',
  onProgress = () => {},
}) {
  const openai = new OpenAI({ apiKey });

  // Build the work queue: 1 course hero + N lesson icons
  const queue = [];
  queue.push({
    key: 'course',
    label: `course hero: "${structure.courseTitle}"`,
    size: SIZE_LANDSCAPE,
    prompt: buildCoursePrompt({
      courseTitle: structure.courseTitle,
      courseDescription: structure.courseDescription || '',
      targetAudience,
      accent,
    }),
  });
  (structure.modules || []).forEach((mod, mi) => {
    (mod.lessons || []).forEach((lesson, li) => {
      queue.push({
        key: `m${mi}-l${li}`,
        label: `lesson icon: "${lesson.title}"`,
        size: SIZE_SQUARE,
        prompt: buildLessonPrompt({
          courseTitle: structure.courseTitle,
          moduleTitle: mod.title,
          lessonTitle: lesson.title,
          lessonSummary: lesson.summary || '',
          accent,
        }),
      });
    });
  });

  const thumbnails = {};
  const total = queue.length;
  let done = 0;
  let failed = 0;

  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const batch = queue.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(item => generateOneImage(openai, item, { model, quality }).catch(err => {
        console.warn(`⚠️  Thumbnail failed for ${item.label}: ${err.message}`);
        return null;
      }))
    );
    results.forEach((b64, idx) => {
      const { key, label } = batch[idx];
      if (b64) {
        thumbnails[key] = b64;
      } else {
        failed++;
      }
      done++;
      onProgress({ done, total, failed, label });
    });

    const hasMoreBatches = i + BATCH_SIZE < queue.length;
    if (hasMoreBatches) await sleep(BATCH_DELAY_MS);
  }

  return { thumbnails, total, failed };
}

// ---------------------------------------------------------------------
// Prompt builders — designed for OpenAI's stronger natural-language adherence
// ---------------------------------------------------------------------
function buildCoursePrompt({ courseTitle, courseDescription, targetAudience, accent }) {
  return `A vibrant, friendly cartoon illustration for an educational online course cover image.

The course is called "${courseTitle}". It teaches: ${courseDescription || '(infer from the title)'}.
The intended audience is ${targetAudience || 'general learners'}.

The illustration should feature cartoon people and/or thematic cartoon objects that clearly represent the course subject. Modern flat cartoon style with soft gradient shading. Friendly, welcoming, energetic. Clear focal point, balanced composition that works as a hero cover image. Bright color palette anchored on ${accent} with complementary cartoon-bright tones. Clean solid or softly gradient background.

CRITICAL RULES:
- Absolutely no text, no words, no letters, no captions, no labels, no signage, no watermarks anywhere in the image. Pure illustration only.
- Stylized cartoon — not photorealistic.
- 3:2 landscape aspect ratio composition.`;
}

function buildLessonPrompt({ courseTitle, moduleTitle, lessonTitle, lessonSummary, accent }) {
  return `A simple, friendly cartoon icon for a single educational lesson thumbnail.

This specific lesson is titled "${lessonTitle}". The lesson teaches: ${lessonSummary || '(infer from the title)'}. It belongs to a course about "${courseTitle}" (specifically the module "${moduleTitle}").

The icon should depict ONE clear subject — either a single cartoon character OR a single thematic object — that visually represents this lesson's specific concept. Minimalist composition that reads clearly even when displayed small. Vibrant flat cartoon style matching the broader course aesthetic. Use ${accent} prominently in the palette. Clean solid or very softly gradient background.

CRITICAL RULES:
- Absolutely no text, no words, no letters, no captions, no labels, no watermarks anywhere in the image.
- Stylized cartoon — not photorealistic.
- Square 1:1 composition with ONE focal subject. No cluttered scenes.`;
}

// ---------------------------------------------------------------------
// Single image generation — calls OpenAI Images API, returns base64 PNG
// ---------------------------------------------------------------------
async function generateOneImage(openai, { prompt, label, size }, { model, quality }) {
  return await retryAi(async () => {
    const result = await openai.images.generate({
      model,
      prompt,
      size,
      quality,
      n: 1,
    });
    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error('OpenAI returned no image data');
    }
    return b64;
  }, {
    label: `Thumbnail (${label})`,
    maxAttempts: 3,
    shouldRetry: (err) => {
      if (isTransient(err)) return true;
      const msg = String(err.message || '').toLowerCase();
      // OpenAI 429 (rate limit) and 5xx are transient; content-policy refusals are not
      if (msg.includes('rate limit') || msg.includes('429')) return true;
      if (msg.includes('no image data')) return true;
      if (msg.includes('content policy') || msg.includes('safety') || msg.includes('moderation')) return false;
      if (msg.includes('organization') && msg.includes('verif')) return false;  // verification not done — won't fix on retry
      return false;
    },
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------
// Helper: convert a base64 string into a Buffer (for upload to CC360)
// ---------------------------------------------------------------------
export function base64ToBuffer(b64) {
  return Buffer.from(b64, 'base64');
}