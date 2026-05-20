// lib/generate-funnel-images.js — Generate AI images for the funnel:
//   • 8 module thumbnails (the "Follow my step by step video training" cards)
//   • 1 laptop mockup (the device shot in the pricing block)
//   • 6 inside-card icons (small flat icons for "What You Will Get" topics)
//
// Mirrors the patterns from generate-thumbnails.js (your course tool). Returns
// a flat map of { key -> base64 PNG }, plus stats. The caller uploads each to
// the GHL media library and stores the resulting URL in the matching custom value.
//
// IMPORTANT: GPT Image models require OpenAI Organization Verification. Without
// it every call 403s. Same gotcha as the course tool — flagged loud so it's
// not a surprise.
//
// VISUAL STYLE: Semi-realistic 3D animated illustration (Pixar/modern-SaaS-illustration
// aesthetic). Module thumbnails and the laptop mockup use the same dimensional 3D
// look as the course thumbnails. The small inside-card icons stay flat because they
// display at 50x50px where 3D detail would be lost.
//
import OpenAI from 'openai';
import { retryAi, isTransient } from './retry.js';

const DEFAULT_MODEL = 'gpt-image-1-mini';
const DEFAULT_QUALITY = 'medium';

// Concurrency — see lib/generate-thumbnails.js for env knobs.
// Same defaults so both run side-by-side without exceeding image rate limits
// (and they don't run concurrently with each other in any push flow).
const BATCH_SIZE     = Number(process.env.AI_IMAGE_CONCURRENCY) || 5;
const BATCH_DELAY_MS = Number(process.env.AI_IMAGE_DELAY_MS)    || 500;

// Image sizes — match aspect ratios of the actual template
const SIZE_PORTRAIT = '1024x1536';    // module cards are tall in the template
const SIZE_LANDSCAPE = '1536x1024';   // laptop mockup is a near-16:9 device shot
const SIZE_SQUARE = '1024x1024';      // inside-card icons (template displays at 50x50)

// Shared style block — kept identical to generate-thumbnails.js so the funnel
// and the course it sells share the same visual DNA. If you update the style,
// update BOTH files in lockstep.
const STYLE_BLOCK = `
Visual style: Semi-realistic 3D animated illustration in the aesthetic of a modern animated film still or premium SaaS marketing illustration (think Pixar, modern Apple keynote graphics, or the 3D illustration style used by Stripe and Notion).

Render quality requirements:
- Stylized 3D characters with friendly, slightly exaggerated proportions (larger expressive eyes, simplified features) — NOT flat 2D cartoon, NOT photorealistic humans.
- Soft realistic lighting with a clear key light, ambient fill, and gentle rim light. Visible (but soft) cast shadows beneath subjects.
- Subtle material textures — matte skin, soft fabric folds, smooth plastic/metal highlights where appropriate. Surfaces feel touchable, not sticker-flat.
- Ambient occlusion in corners and contact points for depth.
- Subtle depth-of-field — main subject is sharply rendered, background slightly softened.
- Smooth, polished surfaces — no rough sketch lines, no pencil/watercolor texture, no harsh outlines.
- Warm, inviting color palette. Vibrant but not oversaturated. Premium feel.`;

/**
 * Generate 8 module thumbnails + 1 laptop mockup + 6 inside-card icons.
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
 *   { "module_1": "<b64>", ..., "module_8": "<b64>", "pricing_laptop": "<b64>",
 *     "inside_card_1_icon": "<b64>", ..., "inside_card_6_icon": "<b64>" }
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

  // Section background images — REMOVED. The themed funnel templates have their
  // own baked-in backgrounds (hero gradient, FAQ block, footer). The AI-generated
  // ones were never wired into the rendered pages, just stored as unused custom
  // values. Removing this saves 3 AI image generations per push (~$0.03 + ~30s).

  // Inside-card icons — 6 small flat icons matching "What You Will Get" topics.
  // KEPT FLAT (not 3D) — they display at 50x50px where 3D detail is lost and
  // the flat-icon-library look reads more clearly at thumbnail size.
  (content.inside_cards || []).slice(0, 6).forEach((c, i) => {
    queue.push({
      key: `inside_card_${i + 1}_icon`,
      label: `inside-card icon: "${c.title}"`,
      size: SIZE_SQUARE,
      prompt: buildIconPrompt({
        courseTitle,
        cardTitle: c.title,
        cardDesc: c.desc,
        accent,
      }),
    });
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
  return `A premium 3D-rendered illustration representing one module of an online course called "${courseTitle}".

This specific module is titled: "${moduleTitle}". It teaches: ${moduleDesc || '(infer from the title)'}.

Compose a vertical scene with stylized 3D characters and/or thematic 3D objects that clearly depict the module's subject matter. The visual weight should sit in the top 2/3 of the frame, with the bottom 1/3 kept visually calmer (softer gradient transitioning toward a paler tone or near-white) so a white title band can be overlaid by the template without clashing.

Color palette anchored on ${accent} as the dominant accent color (clothing, props, accent lighting), supported by complementary warm tones. Background: clean studio soft gradient with subtle depth — not a busy environment.
${STYLE_BLOCK}

CRITICAL RULES:
- Absolutely NO text, NO words, NO letters, NO captions, NO labels, NO watermarks, NO logos anywhere in the image.
- Pure illustration only — no UI mockups, no fake screens with content.
- Portrait 2:3 composition (tall).
- The bottom 1/4 of the image MUST be visually calm and uncluttered.`;
}

function buildLaptopPrompt({ courseTitle, courseDescription, accent }) {
  // The template uses a laptop with a course landing page shown on the screen.
  // We can't make GPT Image draw legible mock text reliably, but a neutral
  // "abstract course UI on a laptop" reads as on-brand without trying to fake text.
  // Laptop hardware stays photorealistic for product-shot credibility; the on-screen
  // illustration matches the 3D animated style of the rest of the funnel.
  return `A premium product mockup of a modern silver laptop on a soft, neutral studio background. The laptop hardware itself is rendered in PHOTOREALISTIC product-shot style — accurate metal finish, realistic screen bezel, natural reflections, soft contact shadow underneath.

On the laptop's screen is a stylized course landing page UI: a colored header band at top, a hero area with a stylized 3D character illustration (semi-realistic 3D rendered style, same aesthetic as a modern animated film still) on the right side of the screen, and a stylized "get started" button. The screen design should evoke an online course platform without containing any legible text — use abstract horizontal bars/blocks to suggest paragraphs and headlines.

The course is about: "${courseTitle}" — ${courseDescription}. Let the on-screen 3D character/scene match that subject.

Use ${accent} as the primary accent color on the screen's header band and call-to-action button. The background outside the laptop is a very soft off-white or pale gradient with subtle depth — clean, premium, ad-ready.

Composition: laptop centered, screen tilted toward camera at a slight angle (10-15°), full device visible. Photorealistic laptop hardware; semi-realistic 3D animated illustration for the UI elements and character ON the screen.

CRITICAL RULES:
- The on-screen UI must NOT contain any legible words, letters, or readable text. Use abstract shapes to imply layout only.
- No watermarks, no logos, no brand names anywhere.
- 3:2 landscape composition.`;
}

// ---------------------------------------------------------------------
// Inside-card icon prompts
// Small flat icons that represent each "What You Will Get" card topic.
// KEPT FLAT (not 3D) because they display at 50x50px in the template — at
// that size, flat icon-library style reads more clearly than 3D detail.
// Style consistency across the set is critical so they read as one icon family.
// ---------------------------------------------------------------------
function buildIconPrompt({ courseTitle, cardTitle, cardDesc, accent }) {
  return `A flat, minimal, single-color icon representing the concept "${cardTitle}". Context: ${cardDesc || '(infer from the title)'}.

This icon belongs to a series of 6 cohesive icons for an online course called "${courseTitle}". Style: filled silhouette in solid ${accent} color on a clean white background, simple geometric shapes, clean rounded lines, modern minimalist icon design. Should read clearly when displayed at 50x50 pixels.

Composition:
- 1:1 square canvas
- The icon shape itself occupies the central 50-60% of the canvas
- Generous breathing room around the edges (pure white margin)
- Centered, symmetric where possible
- A single subject — one clear shape representing the topic, not a busy scene

CRITICAL RULES:
- Absolutely NO text, NO words, NO letters, NO numbers anywhere
- Single-color flat icon ONLY — no gradients, no shading, no 3D effects, no outlines, no drop shadows
- Pure white background (#FFFFFF) — not transparent, not patterned
- Icon color exactly ${accent} — no other colors used
- Clean professional icon-library aesthetic, like Heroicons or Lucide`;
}


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