// lib/extract-pdf.js — read a PDF file and return its plain text
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

// Heuristic threshold below which the PDF likely contains scanned images
// rather than embedded text. pdf-parse extracts text only — it does NOT OCR.
// Anything under ~2k chars for a multi-module course is almost certainly a
// scanned PDF that needs OCR before we can read its structure.
const SUSPICIOUS_TEXT_THRESHOLD = 2000;

export async function extractPdfText(pdfPath) {
  const buffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(buffer);
  const text = (data.text || '').trim();

  // Diagnostic logging — helps debug "AI only generated N modules" reports.
  // If you see "only 3 modules generated" and the log shows e.g. 240k chars,
  // the issue is on the AI prompt side. If you see e.g. 800 chars from a
  // 100-page PDF, the PDF is image-based and pdf-parse can't read it without OCR.
  console.log(`📄 PDF parsed: ${data.numpages} pages, ${text.length} chars extracted`);

  if (text.length < SUSPICIOUS_TEXT_THRESHOLD && data.numpages > 3) {
    console.warn(
      `⚠️  PDF text suspiciously short (${text.length} chars across ${data.numpages} pages). ` +
      `This is usually a scanned/image-based PDF — pdf-parse does NOT do OCR. ` +
      `Course outline generation will likely fail or under-generate. ` +
      `Consider OCR'ing the PDF first (e.g. with Tesseract or Adobe Acrobat) and re-uploading.`
    );
  }

  return { text, pages: data.numpages };
}