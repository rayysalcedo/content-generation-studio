// =====================================================================
// Content Generation Studio — CLI mode
// (For the web studio, run `node server.js` instead)
//
// Usage: node build-course.js <pdf-path> "<title>" "<audience>" "<instructions>"
// =====================================================================
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

import { extractPdfText } from './lib/extract-pdf.js';
import { generateCourseStructure } from './lib/generate.js';
import { importCourse } from './lib/ghl.js';

const {
  GHL_PIT_TOKEN,
  GHL_LOCATION_ID,
  GEMINI_API_KEY,
  GEMINI_TEXT_MODEL = 'gemini-3.7-flash',
  THEME_ACCENT = '#6366f1',
} = process.env;

if (!GHL_PIT_TOKEN || !GHL_LOCATION_ID || !GEMINI_API_KEY) {
  console.error('❌ Missing env vars. Required: GHL_PIT_TOKEN (PIT), GHL_LOCATION_ID, GEMINI_API_KEY');
  process.exit(1);
}

async function main() {
  const [, , pdfArg, titleArg, audienceArg, ...instructionsArg] = process.argv;
  if (!pdfArg) {
    console.error('Usage: node build-course.js <pdf-path> "<title>" "<audience>" "<instructions>"');
    console.error('       (For the web studio: node server.js)');
    process.exit(1);
  }
  const pdfPath = path.resolve(pdfArg);
  if (!fs.existsSync(pdfPath)) {
    console.error(`❌ PDF not found: ${pdfPath}`);
    process.exit(1);
  }
  const courseTitle = titleArg || path.basename(pdfPath, '.pdf');
  const targetAudience = audienceArg || 'general learners';
  const instructions = instructionsArg.join(' ');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' Content Generation Studio (CLI)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` PDF:        ${pdfPath}`);
  console.log(` Title:      ${courseTitle}`);
  console.log(` Audience:   ${targetAudience}`);
  console.log(` Location:   ${GHL_LOCATION_ID}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const t0 = Date.now();

  console.log(`📄 Reading PDF...`);
  const { text, pages } = await extractPdfText(pdfPath);
  console.log(`   Extracted ${text.length} characters from ${pages} pages`);

  console.log(`🤖 Generating course structure with Gemini (${GEMINI_TEXT_MODEL})...`);
  const structure = await generateCourseStructure({
    apiKey: GEMINI_API_KEY,
    model: GEMINI_TEXT_MODEL,
    mode: 'pdf',
    sourceText: text,
    courseTitle,
    targetAudience,
    instructions,
  });
  structure.courseTitle = courseTitle;
  const lessonCount = structure.modules.reduce((s, m) => s + (m.lessons?.length || 0), 0);
  console.log(`   Generated ${structure.modules.length} modules, ${lessonCount} lessons`);

  console.log(`🚀 Importing to GoHighLevel...`);
  const course = await importCourse({
    pit: GHL_PIT_TOKEN,
    locationId: GHL_LOCATION_ID,
    draft: structure,
    accent: THEME_ACCENT,
  });

  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' ✅ DONE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` Course ID:   ${course.id}`);
  console.log(` Course Name: ${course.title}`);
  console.log(` Time:        ${seconds}s`);
  console.log(` Open it:     ${course.url}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(err => {
  console.error('\n💥 Fatal error:', err.message);
  if (err.response?.data) console.error('   Response:', JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
