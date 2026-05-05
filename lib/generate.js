// lib/generate.js — Generate structured course outline from PDF text or a course description
import { GoogleGenerativeAI } from '@google/generative-ai';
import { retryAi } from './retry.js';

export async function generateCourseStructure({
  apiKey,
  model = 'gemini-2.0-flash',
  mode,                  // 'pdf' or 'description'
  sourceText,            // PDF text OR course description
  courseTitle,
  targetAudience,
  instructions = '',
  moduleCount,           // optional, only for description mode
  lessonsPerModule,      // optional, only for description mode
}) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const m = genAI.getGenerativeModel({
    model,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.4,
      maxOutputTokens: 32000,
    },
  });

  const prompt = mode === 'pdf'
    ? buildPdfPrompt({ pdfText: sourceText, courseTitle, targetAudience, instructions })
    : buildDescriptionPrompt({ description: sourceText, courseTitle, targetAudience, instructions, moduleCount, lessonsPerModule });

  return await retryAi(async () => {
    const result = await m.generateContent(prompt);
    const responseText = result.response.text();
    const parsed = safeParseJson(responseText);
    if (!parsed.modules || !Array.isArray(parsed.modules) || parsed.modules.length === 0) {
      throw new Error('AI response missing "modules" array.');
    }
    return parsed;
  }, { label: 'Course structure generation', maxAttempts: 4 });
}

function buildPdfPrompt({ pdfText, courseTitle, targetAudience, instructions }) {
  return `You are converting an existing course document into structured lesson content for CourseCreator360.

The source document below ALREADY HAS A COURSE STRUCTURE. Your job is to faithfully respect that structure — do not invent extra modules, do not skip sections that exist, do not rearrange topics. Match the document's natural module/lesson breakdown as closely as possible.

Output JSON in this EXACT structure:

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
1. Mirror the source document's existing module/lesson structure. If the document has 5 sections, generate 5 modules.
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

Source Document (preserve its structure):
${(sourceText => sourceText.slice(0, 60000))(pdfText)}`;
}

function buildDescriptionPrompt({ description, courseTitle, targetAudience, instructions, moduleCount, lessonsPerModule }) {
  const moduleHint = moduleCount
    ? `Generate EXACTLY ${moduleCount} modules.`
    : `Generate 4-6 modules based on natural topic breakdown.`;
  const lessonHint = lessonsPerModule
    ? `Each module must have EXACTLY ${lessonsPerModule} lessons.`
    : `Each module should have 3-5 lessons.`;

  return `You are designing a brand-new course from a brief description for CourseCreator360. The user has given you a course concept — your job is to invent a logical, comprehensive curriculum that teaches that concept well.

Output JSON in this EXACT structure:

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
