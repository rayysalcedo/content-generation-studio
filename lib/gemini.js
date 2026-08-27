// lib/gemini.js — Single Gemini client used by every AI module.
//
// Two helpers, both built on the Gemini Interactions API (@google/genai):
//   • generateJsonText()   → text model, JSON-only output (course structure, workbooks, funnel copy)
//   • generateImageBase64() → Nano Banana image model, returns base64 PNG
//
// Model names are passed in by the caller (server.js reads them from env), so
// swapping models is a config change, not a code change.
//
// Image sizes: Gemini takes an aspect ratio + a size class, not pixel dims.
//   aspect_ratio: '1:1' | '3:2' | '2:3' | '16:9' | '9:16' | '4:3' | ...
//   image_size:   '512' | '1K' | '2K' | '4K'   (uppercase K is required)
//   Note: gemini-3.1-flash-lite-image only supports '1K'; '512' needs gemini-3.1-flash-image.
//
import { GoogleGenAI } from '@google/genai';

const clients = new Map();
function client(apiKey) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  if (!clients.has(apiKey)) clients.set(apiKey, new GoogleGenAI({ apiKey }));
  return clients.get(apiKey);
}

/**
 * Ask a Gemini text model for a JSON object. Returns the raw text; callers
 * parse it (they already have tolerant parsers for fenced/quoted output).
 */
export async function generateJsonText({ apiKey, model, prompt, maxOutputTokens = 16000 }) {
  const ai = client(apiKey);
  const interaction = await ai.interactions.create({
    model,
    input: prompt,
    response_format: { type: 'text', mime_type: 'application/json' },
    generation_config: { max_output_tokens: maxOutputTokens },
  });
  const text = interaction.output_text || collectText(interaction);
  if (!text) throw new Error('Gemini returned no text');
  return text;
}

/**
 * Generate one image. Returns base64 PNG data (no data: prefix).
 */
export async function generateImageBase64({ apiKey, model, prompt, aspectRatio = '1:1', imageSize = '1K' }) {
  const ai = client(apiKey);
  const interaction = await ai.interactions.create({
    model,
    input: prompt,
    response_format: {
      type: 'image',
      mime_type: 'image/png',
      aspect_ratio: aspectRatio,
      image_size: normalizeSize(imageSize),
    },
  });
  const img = interaction.output_image || collectImage(interaction);
  if (!img?.data) throw new Error('Gemini returned no image data');
  return img.data;
}

// ---- helpers ---------------------------------------------------------------

// Walk interaction.steps for the last model_output text/image block, in case
// the convenience properties are missing (e.g. interleaved output).
function collectText(interaction) {
  let out = '';
  for (const step of interaction?.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content || []) {
      if (block.type === 'text' && block.text) out += block.text;
    }
  }
  return out;
}

function collectImage(interaction) {
  let last = null;
  for (const step of interaction?.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content || []) {
      if (block.type === 'image' && block.data) last = block;
    }
  }
  return last;
}

// Accept lower-case / legacy values from env and map them to what the API wants.
function normalizeSize(s) {
  const v = String(s || '1K').trim().toLowerCase();
  if (v === '512' || v === '0.5k' || v === 'low') return '512';
  if (v === '2k' || v === 'high') return '2K';
  if (v === '4k') return '4K';
  return '1K';   // '1k', 'medium', anything else
}
