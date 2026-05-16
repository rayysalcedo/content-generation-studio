// lib/generate-funnel-images.js — Generate AI images for the funnel:
//   • 8 module thumbnails (the "Follow my step by step video training" cards)
//   • 1 laptop mockup (the device shot in the pricing block)
//
// Mirrors the patterns from generate-thumbnails.js (your course tool). Returns
// a flat map of { key -> base64 PNG }, plus stats. The caller uploads each to
// the GHL media library and stores the resulting URL in the matching custom value.
//
// IMPORTANT: GPT Image models require OpenAI Organization Verification. Without
// it every call 403s. Same gotcha as the course tool — flagged loud so it's
// not a surprise.
//
import OpenAI from 'openai';
import { retryAi, isTransient } from './retry.js';

const DEFAULT_MODEL = 'gpt-image-1-mini';
const DEFAULT_QUALITY = 'medium';

// Pacing — same as course tool (tier-1 friendly)
const BATCH_SIZE = 1;
const BATCH_DELAY_MS = 3000;

// Image sizes — match aspect ratios of the actual template
const SIZE_PORTRAIT = '1024x1536';    // module cards are tall in the template
const SIZE_LANDSCAPE = '1536x1024';   // laptop mockup is a near-16:9 device shot

/**
 * Generate 8 module thumbnails + 1 laptop mockup.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.model]
 * @param {string} [opts.quality]
 * @param {Object} opts.content       - the funnel content object from generate-funnel.js
 * @param {string} opts.courseTitle
 * @param {string} opts.accent        - hex brand color
 * @param {Function} [opts.onProgress]
 * @returns {Promise<{ images: Object<string,string>, total: number, failed: number }>}
 *
 * Output key shape:
 *   { "module_1": "<b64>", ..., "module_8": "<b64>", "pricing_laptop": "<b64>" }
 */
export async function generateFunnelImages({
  apiKey,
  model = DEFAULT_MODEL,
  quality = DEFAULT_QUALITY,
  content,
  courseTitle,
  accent = '#1A56DB',
  onProgress = () => {},
}) {
  const openai = new OpenAI({ apiKey });

  // Build the work queue
  const queue = [];
  (content.modules || []).forEach((m, i) => {
    queue.push({
      key: `module_${i + 1}`,
      label: `module thumbnail: "${m.title}"`,
      size: SIZE_PORTRAIT,
      prompt: buildModulePrompt({
        courseTitle,
        moduleTitle: m.title,
        moduleDesc: m.desc,
        accent,
      }),
    });
  });
  // Laptop mockup
  queue.push({
    key: 'pricing_laptop',
    label: 'laptop mockup for pricing block',
    size: SIZE_LANDSCAPE,
    prompt: buildLaptopPrompt({
      courseTitle,
      courseDescription: content.hero?.subheadline || '',
      accent,
    }),
  });

  const images = {};
  const total = queue.length;
  let done = 0;
  let failed = 0;

  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const batch = queue.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(item => generateOneImage(openai, item, { model, quality }).catch(err => {
        console.warn(`⚠️  Funnel image failed for ${item.label}: ${err.message}`);
        return null;
      }))
    );
    results.forEach((b64, idx) => {
      const { key, label } = batch[idx];
      if (b64) {
        images[key] = b64;
      } else {
        failed++;
      }
      done++;
      onProgress({ done, total, failed, label });
    });

    const hasMoreBatches = i + BATCH_SIZE < queue.length;
    if (hasMoreBatches) await sleep(BATCH_DELAY_MS);
  }

  return { images, total, failed };
}

// ---------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------
function buildModulePrompt({ courseTitle, moduleTitle, moduleDesc, accent }) {
  // The template cards are tall and the title appears overlaid as a band at the
  // bottom in white text. We want the AI image to leave the bottom 1/4 visually
  // clean enough that overlaid white text reads well. Asking the model directly
  // is more reliable than post-processing.
  return `A friendly, modern cartoon illustration representing one module of an online course called "${courseTitle}".

This specific module is titled: "${moduleTitle}". It teaches: ${moduleDesc || '(infer from the title)'}.

The illustration should clearly depict the module's subject matter with cartoon characters and/or thematic objects. Flat cartoon style with soft gradient shading. The composition should be vertically balanced — most of the visual weight in the top 2/3, with the bottom 1/3 of the image kept calm and uncluttered so a white title band can be overlaid by the template without clashing.

Color palette anchored on ${accent} with complementary cartoon-bright tones. Light background, ideally a soft gradient that transitions toward white or a pale tint at the bottom. Stylized cartoon look, NOT photorealistic.

CRITICAL RULES:
- Absolutely NO text, NO words, NO letters, NO captions, NO labels, NO watermarks anywhere in the image.
- Pure illustration only — no UI mockups, no fake screens with content.
- Portrait 2:3 composition (tall).`;
}

function buildLaptopPrompt({ courseTitle, courseDescription, accent }) {
  // The template uses a laptop with a course landing page shown on the screen.
  // We can't make GPT Image draw legible mock text reliably, but a neutral
  // "abstract course UI on a laptop" reads as on-brand without trying to fake text.
  return `A clean product mockup of a modern silver laptop on a soft, neutral background. On the laptop's screen is a generic course landing page UI: a colored header band, a hero area with an abstract person illustration on the right side of the screen, and a stylized "Get started" button. The screen design should evoke an online course platform without containing any legible text — use abstract horizontal lines or blocks to suggest paragraphs and headlines.

The course is about: "${courseTitle}" — ${courseDescription}. Match the visual tone implied by that topic.

Use ${accent} as the primary accent color on the screen's header band and call-to-action button. The background outside the laptop is a very soft off-white or pale gradient — clean, premium, ad-ready.

Composition: laptop centered, screen tilted toward camera at a slight angle (10-15°), full device visible. Photorealistic product-shot style for the laptop hardware itself; flat cartoon style for the UI elements ON the screen.

CRITICAL RULES:
- The on-screen UI must NOT contain any legible words, letters, or readable text. Use abstract shapes to imply layout only.
- No watermarks, no logos, no brand names anywhere.
- 3:2 landscape composition.`;
}

// ---------------------------------------------------------------------
// Single image generation — identical retry shape to generate-thumbnails.js
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
    if (!b64) throw new Error('OpenAI returned no image data');
    return b64;
  }, {
    label: `Funnel image (${label})`,
    maxAttempts: 3,
    shouldRetry: (err) => {
      if (isTransient(err)) return true;
      const msg = String(err.message || '').toLowerCase();
      if (msg.includes('rate limit') || msg.includes('429')) return true;
      if (msg.includes('no image data')) return true;
      if (msg.includes('content policy') || msg.includes('safety') || msg.includes('moderation')) return false;
      if (msg.includes('organization') && msg.includes('verif')) return false;
      return false;
    },
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function base64ToBuffer(b64) {
  return Buffer.from(b64, 'base64');
}
