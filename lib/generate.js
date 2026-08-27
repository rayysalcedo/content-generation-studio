// lib/generate.js — Generate structured course outline from PDF text or a course description
// using Gemini (Interactions API) in JSON mode.
//
import { generateJsonText } from './gemini.js';
import { retryAi } from './retry.js';

// Safety ceiling on PDF text sent to the model. Gemini models support
// 128k–1M token context windows, so we can comfortably send very large PDFs.
// We still cap as a defensive measure against pathological inputs (e.g. a 2000-page
// PDF dump) — but the cap is high enough that real course PDFs are never truncated.
//   Previous value: 60,000 chars (~15k tokens) — this was truncating ~9-module PDFs
//                   partway through module 3, causing the AI to under-generate.
//   Current value:  500,000 chars (~125k tokens) — fits comfortably in 128k context.
const MAX_PDF_CHARS = 500_000;

export async function generateCourseStructure({
  apiKey,
  model = 'gemini-3.7-flash',
  mode,                  // 'pdf' or 'description'
  sourceText,            // PDF text OR course description
  courseTitle,
  targetAudience,
  instructions = '',
  moduleCount,           // optional, only for description mode
  lessonsPerModule,      // optional, only for description mode
}) {
  const prompt = mode === 'pdf'
    ? buildPdfPrompt({ pdfText: sourceText, courseTitle, targetAudience, instructions })
    : buildDescriptionPrompt({ description: sourceText, courseTitle, targetAudience, instructions, moduleCount, lessonsPerModule });

  return await retryAi(async () => {
    // 24000 output tokens: larger courses (9+ modules with rich lesson bodies)
    // can brush a 16k ceiling.
    const responseText = await generateJsonText({ apiKey, model, prompt, maxOutputTokens: 24000 });
    const parsed = safeParseJson(responseText);
    if (!parsed.modules || !Array.isArray(parsed.modules) || parsed.modules.length === 0) {
      throw new Error('AI response missing "modules" array.');
    }
    return parsed;
  }, { label: 'Course structure generation', maxAttempts: 4 });
}

function buildPdfPrompt({ pdfText, courseTitle, targetAudience, instructions }) {
  // Defensive truncation only — real course PDFs fit comfortably.
  const truncatedPdf = pdfText.length > MAX_PDF_CHARS
    ? pdfText.slice(0, MAX_PDF_CHARS) + '\n\n[...source truncated at safety cap...]'
    : pdfText;

  return `You are converting an existing course document into structured lesson content for CourseCreator360.

The source document below ALREADY HAS A COURSE STRUCTURE. Your job is to faithfully respect that structure — do not invent extra modules, do not skip sections that exist, do not rearrange topics, do not compress multiple modules into one. Match the document's natural module/lesson breakdown EXACTLY.

═══════════════════════════════════════════════════════════════════
MANDATORY FIRST STEP — COUNT THE MODULES BEFORE YOU WRITE ANYTHING
═══════════════════════════════════════════════════════════════════
Before generating any content, scan the ENTIRE source document and identify every distinct top-level module, chapter, part, section, or unit. Course documents typically signal these with patterns like:
  • "Module 1:", "Module 2:", ... or "Chapter 1:", "Chapter 2:", ...
  • "Part I", "Part II", ... or "Unit 1", "Unit 2", ...
  • Major numbered or titled sections that contain their own sub-lessons
  • Table of contents entries that list multiple parallel topics

You MUST output exactly as many modules in the JSON as exist in the source. If the source has 9 modules, output 9. If it has 12, output 12. If it has 4, output 4. Do not merge, do not skip, do not summarize multiple modules into one.

State the final module count in the first sentence of "courseDescription" (e.g., "This 9-module course covers..."). Then verify your "modules" array length matches that count before responding.

═══════════════════════════════════════════════════════════════════
OUTPUT FORMAT (single valid JSON object, exact shape):
═══════════════════════════════════════════════════════════════════

{
  "courseDescription": "Brief 2-3 sentence overview. The FIRST sentence MUST state the total module count (e.g., 'This 9-module course teaches...').",
  "modules": [
    {
      "title": "Module title (5-8 words)",
      "description": "Brief 1-sentence module overview",
      "lessons": [
        {
          "title": "Lesson title (3-7 words)",
          "summary": "1-sentence plain-text summary of what this lesson teaches",
          "keyTakeaways": ["3 to 5 short bullet-style takeaways", "Each one one short sentence", "Concrete and specific"],
          "sections": [
            {
              "heading": "Section heading drawn from the source",
              "body": "Section body in 2-4 sentences. Use <strong>bold</strong> and <em>italic</em> sparingly to emphasize key terms."
            }
          ],
          "proTip": "Optional actionable tip drawn from the source. Empty string if none.",
          "reflection": "Optional thought-provoking question. Empty string if none."
        }
      ]
    }
  ]
}

Content rules:
1. The number of modules in your output MUST equal the number of modules in the source. Recount before responding.
2. Each lesson should have 2-4 sections, 3-5 key takeaways, optional pro tip and reflection.
3. Section "body" can use ONLY <strong> and <em> as inline tags. NO other HTML.
4. Section bodies are 2-4 sentences each. Substance over fluff.
5. Match tone, terminology, and depth of the source material.
6. Output ONLY the JSON object — no markdown fences, no commentary.

CRITICAL JSON FORMATTING RULES:
- Use ONLY straight ASCII double quotes (") for strings.
- Use straight apostrophes (') not curly ones, in body text.
- Do NOT include unescaped double quotes inside string values.
- Do NOT include line breaks inside string values.
- Do NOT add trailing commas.
- Output must be parseable by strict JSON.parse().

Course Title: ${courseTitle}
Target Audience: ${targetAudience}
Special Instructions: ${instructions || '(none)'}

Source Document (preserve its structure — count modules carefully before writing):
${truncatedPdf}`;
}

function buildDescriptionPrompt({ description, courseTitle, targetAudience, instructions, moduleCount, lessonsPerModule }) {
  const moduleHint = moduleCount
    ? `Generate EXACTLY ${moduleCount} modules.`
    : `Generate 4-6 modules based on natural topic breakdown.`;
  const lessonHint = lessonsPerModule
    ? `Each module must have EXACTLY ${lessonsPerModule} lessons.`
    : `Each module should have 3-5 lessons.`;

  return `You are designing a brand-new course from a brief description for CourseCreator360. The user has given you a course concept — your job is to invent a logical, comprehensive curriculum that teaches that concept well.

Output a single valid JSON object in this EXACT structure:

{
  "courseDescription": "Brief 2-3 sentence overview of the entire course",
  "modules": [
    {
      "title": "Module title (5-8 words)",
      "description": "Brief 1-sentence module overview",
      "lessons": [
        {
          "title": "Lesson title (3-7 words)",
          "summary": "1-sentence plain-text summary of what this lesson teaches",
          "keyTakeaways": ["3 to 5 short bullet-style takeaways", "Each one one short sentence", "Concrete and specific"],
          "sections": [
            {
              "heading": "Section heading you've invented",
              "body": "Section body in 2-4 sentences of original instructional content. Use <strong>bold</strong> and <em>italic</em> sparingly."
            }
          ],
          "proTip": "An actionable tip you've crafted. Empty string if not applicable.",
          "reflection": "A thought-provoking question for the learner. Empty string if not applicable."
        }
      ]
    }
  ]
}

Content rules:
1. ${moduleHint}
2. ${lessonHint}
3. Each lesson: 2-4 sections (real instructional content, not placeholders), 3-5 key takeaways, 1 pro tip, 1 reflection.
4. Build a coherent learning arc — early modules cover fundamentals, later modules cover application/advanced topics.
5. Section "body" can use ONLY <strong> and <em> as inline tags. NO other HTML.
6. Section bodies are 2-4 sentences. Real instructional substance, not fluff.
7. Match the tone implied by the description and target audience.
8. Output ONLY the JSON object — no markdown fences, no commentary.

CRITICAL JSON FORMATTING RULES:
- Use ONLY straight ASCII double quotes (") for strings.
- Use straight apostrophes (') in body text.
- Do NOT include unescaped double quotes inside string values.
- Do NOT include line breaks inside string values.
- Do NOT add trailing commas.
- Output must be parseable by strict JSON.parse().

Course Title: ${courseTitle}
Target Audience: ${targetAudience}
Course Description (the seed concept): ${description}
Special Instructions: ${instructions || '(none)'}`;
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
    throw new Error(`AI returned malformed JSON: ${e.message}`);
  }
}