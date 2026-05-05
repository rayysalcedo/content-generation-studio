// lib/extract-pdf.js — read a PDF file and return its plain text
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

export async function extractPdfText(pdfPath) {
  const buffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(buffer);
  const text = (data.text || '').trim();
  return { text, pages: data.numpages };
}
