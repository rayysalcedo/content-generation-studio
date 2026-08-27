// lib/pdf-renderer.js — Render a lesson workbook as a beautifully branded PDF
//
// Each PDF is a self-contained workbook for a single lesson. Includes:
//   - Header band with accent color, course title, lesson title
//   - Lesson summary (italic, accent left-border)
//   - Workbook questions (with writing lines)
//   - Action items (with checkboxes)
//   - Reflection prompt (with lined writing area)
//   - Notes section (lined paper)
//   - Footer with course branding
//
import PDFDocument from 'pdfkit';
import { Buffer } from 'buffer';

// ---------------------------------------------------------------------
// Theme — derived from the same accent color the studio uses
// ---------------------------------------------------------------------
function buildTheme(accent = '#6366f1') {
  return {
    accent,
    accentDark: shade(accent, -0.18),
    accentSoft: tint(accent, 0.92),
    text: '#0f172a',
    textMuted: '#64748b',
    border: '#e2e8f0',
    bgLight: '#f8fafc',
  };
}

// Lighten a hex toward white by `pct` (0..1)
function tint(hex, pct) {
  const { r, g, b } = parseHex(hex);
  const mix = v => Math.round(v + (255 - v) * pct);
  return rgbHex(mix(r), mix(g), mix(b));
}
// Darken a hex toward black by `pct` (negative pct works as darkening factor)
function shade(hex, pct) {
  const { r, g, b } = parseHex(hex);
  const mix = v => Math.max(0, Math.min(255, Math.round(v + v * pct)));
  return rgbHex(mix(r), mix(g), mix(b));
}
function parseHex(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function rgbHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------
// Public API — renderWorkbookPdf
// ---------------------------------------------------------------------
/**
 * Render a lesson workbook to a PDF buffer.
 *
 * @param {Object} input
 * @param {string} input.courseTitle
 * @param {string} input.lessonTitle
 * @param {number} input.lessonNumber
 * @param {string} input.summary - 1-2 sentence summary
 * @param {string[]} input.questions - workbook questions
 * @param {string[]} input.actionItems - checkbox action items
 * @param {string} input.reflection - reflection prompt
 * @param {string} [input.accent] - hex color
 * @returns {Promise<Buffer>}
 */
export async function renderWorkbookPdf(input) {
  const T = buildTheme(input.accent || '#6366f1');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 0, bottom: 56, left: 56, right: 56 },
      info: {
        Title: `${input.courseTitle} — ${input.lessonTitle}`,
        Author: 'Content Generation Studio',
        Subject: 'Lesson Workbook',
      },
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawHeader(doc, T, input);
    drawSummary(doc, T, input.summary);

    // Estimate space needed for each section so we don't orphan headings
    const questionsHeight = (input.questions?.length || 0) * 130;
    drawSectionHeading(doc, T, '01', 'Workbook Questions', Math.min(questionsHeight, 250));
    drawQuestions(doc, T, input.questions || []);

    const actionsHeight = (input.actionItems?.length || 0) * 35;
    drawSectionHeading(doc, T, '02', 'Action Items', Math.min(actionsHeight, 200));
    drawActionItems(doc, T, input.actionItems || []);

    drawSectionHeading(doc, T, '03', 'Reflection', 220);
    drawReflection(doc, T, input.reflection);

    drawSectionHeading(doc, T, '04', 'Notes', 150);
    drawNotes(doc, T);

    drawFooter(doc, T, input);

    doc.end();
  });
}

// ---------------------------------------------------------------------
// Drawing functions
// ---------------------------------------------------------------------
function drawHeader(doc, T, input) {
  const headerHeight = 110;
  // Accent band
  doc.rect(0, 0, doc.page.width, headerHeight).fill(T.accent);
  // Subtle darker accent strip
  doc.rect(0, headerHeight - 6, doc.page.width, 6).fill(T.accentDark);

  // Course title (small uppercase)
  doc.font('Helvetica-Bold')
    .fontSize(9)
    .fillColor('#ffffff')
    .text(input.courseTitle.toUpperCase(), 56, 28, {
      width: doc.page.width - 112,
      characterSpacing: 1.2,
    });

  // Lesson number badge + lesson title
  doc.font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#ffffff')
    .text(`LESSON ${String(input.lessonNumber).padStart(2, '0')}`, 56, 50, {
      characterSpacing: 1.2,
    });

  doc.font('Helvetica-Bold')
    .fontSize(22)
    .fillColor('#ffffff')
    .text(input.lessonTitle, 56, 66, {
      width: doc.page.width - 112,
      lineGap: 0,
    });

  // Reset position below header
  doc.y = headerHeight + 32;
  doc.x = 56;
}

function drawSummary(doc, T, summary) {
  if (!summary) return;
  const startY = doc.y;
  // Accent left border
  doc.rect(56, startY, 3, 0).fill(T.accent); // placeholder
  const initialY = doc.y;
  doc.font('Helvetica-Oblique')
    .fontSize(11.5)
    .fillColor(T.textMuted)
    .text(summary, 70, startY, {
      width: doc.page.width - 126,
      lineGap: 3,
    });
  const endY = doc.y;
  // Draw the accent left border (after we know the height)
  doc.rect(56, initialY, 3, endY - initialY).fill(T.accent);
  doc.y = endY + 18;
}

function drawSectionHeading(doc, T, num, label, minBodyHeight = 100) {
  // Reserve room for the heading itself (~40px) + minimum body content
  const headingHeight = 40;
  if (doc.y + headingHeight + minBodyHeight > doc.page.height - 70) {
    doc.addPage();
  }
  const y = doc.y + 10;

  // Number badge
  doc.circle(64, y + 8, 11).fill(T.accent);
  doc.font('Helvetica-Bold')
    .fontSize(9)
    .fillColor('#ffffff')
    .text(num, 56, y + 4, { width: 16, align: 'center' });

  doc.font('Helvetica-Bold')
    .fontSize(13)
    .fillColor(T.text)
    .text(label.toUpperCase(), 86, y + 2, {
      characterSpacing: 1.2,
    });

  // Underline
  const lineY = doc.y + 4;
  doc.moveTo(56, lineY).lineTo(doc.page.width - 56, lineY)
    .lineWidth(0.5).strokeColor(T.border).stroke();
  doc.y = lineY + 14;
  doc.x = 56;
}

function drawQuestions(doc, T, questions) {
  questions.forEach((q, i) => {
    // Each question needs ~140px (text + 3 writing lines + spacing)
    if (doc.y + 140 > doc.page.height - 60) doc.addPage();
    doc.font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(T.text)
      .text(`Q${i + 1}.`, 56, doc.y, { continued: true })
      .font('Helvetica')
      .fillColor(T.text)
      .text(`  ${q}`, { width: doc.page.width - 112, lineGap: 2 });
    drawWritingLines(doc, T, 3);
    doc.y += 18;
  });
}

function drawActionItems(doc, T, items) {
  // Estimate total height needed for ALL items together
  let totalHeight = 0;
  items.forEach(item => {
    totalHeight += item.length > 80 ? 50 : 30;
  });
  totalHeight += 16; // bottom padding

  // If the whole block won't fit on the current page, force a page break first
  // so action items stay together as one logical unit
  if (doc.y + totalHeight > doc.page.height - 60) {
    doc.addPage();
  }

  items.forEach(item => {
    const y = doc.y;
    // Checkbox
    doc.rect(56, y + 1, 11, 11).lineWidth(1).strokeColor(T.text).stroke();
    doc.font('Helvetica')
      .fontSize(11)
      .fillColor(T.text)
      .text(item, 76, y, { width: doc.page.width - 132, lineGap: 2 });
    doc.y += 14;
  });
  doc.y += 16;
}

function drawReflection(doc, T, reflection) {
  if (!reflection) return;
  // Estimate: prompt text height + 6 writing lines (132px) + padding
  const reflectionLines = Math.ceil(reflection.length / 80);
  const totalHeight = (reflectionLines * 18) + (6 * 22) + 24;
  if (doc.y + totalHeight > doc.page.height - 60) doc.addPage();

  doc.font('Helvetica-Oblique')
    .fontSize(12)
    .fillColor(T.text)
    .text(reflection, 56, doc.y, {
      width: doc.page.width - 112,
      lineGap: 3,
    });
  doc.y += 8;
  drawWritingLines(doc, T, 6);
  doc.y += 16;
}

function drawNotes(doc, T) {
  if (doc.y > doc.page.height - 100) doc.addPage();
  // Fill the rest of the page with lined paper, up to a sensible limit
  const linesAvailable = Math.floor((doc.page.height - 90 - doc.y) / 22);
  const linesToDraw = Math.min(Math.max(6, linesAvailable), 18);
  drawWritingLines(doc, T, linesToDraw);
}

function drawWritingLines(doc, T, count) {
  const xStart = 56;
  const xEnd = doc.page.width - 56;
  const lineSpacing = 22;
  let y = doc.y + 6;
  for (let i = 0; i < count; i++) {
    if (y > doc.page.height - 80) {
      doc.addPage();
      y = doc.y + 6;
    }
    doc.moveTo(xStart, y).lineTo(xEnd, y)
      .lineWidth(0.5).strokeColor(T.border).stroke();
    y += lineSpacing;
  }
  doc.y = y;
}

function drawFooter(doc, T, input) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - 36;
    doc.font('Helvetica')
      .fontSize(8.5)
      .fillColor(T.textMuted)
      .text(input.courseTitle, 56, y, { lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, 0, y, {
      width: doc.page.width - 56,
      align: 'right',
      lineBreak: false,
    });
  }
}