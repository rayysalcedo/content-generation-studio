// lib/render-html.js — Render a structured lesson into beautiful styled HTML

export function buildTheme(accent = '#6366f1') {
  // Derive soft and border tints from the accent color
  // Simple approach: use known "good pairs" per common accents, or fall back to indigo defaults
  const ACCENT_PAIRS = {
    '#6366f1': { soft: '#eef2ff', border: '#c7d2fe' }, // indigo
    '#0ea5e9': { soft: '#e0f2fe', border: '#bae6fd' }, // sky
    '#10b981': { soft: '#ecfdf5', border: '#a7f3d0' }, // emerald
    '#16a34a': { soft: '#f0fdf4', border: '#bbf7d0' }, // green
    '#dc2626': { soft: '#fef2f2', border: '#fecaca' }, // red
    '#ea580c': { soft: '#fff7ed', border: '#fed7aa' }, // orange
    '#f59e0b': { soft: '#fffbeb', border: '#fde68a' }, // amber
    '#d946ef': { soft: '#fdf4ff', border: '#f5d0fe' }, // fuchsia
    '#8b5cf6': { soft: '#f5f3ff', border: '#ddd6fe' }, // violet
    '#ec4899': { soft: '#fdf2f8', border: '#fbcfe8' }, // pink
    '#0f172a': { soft: '#f1f5f9', border: '#cbd5e1' }, // slate (mono)
  };
  const normalized = accent.toLowerCase();
  const pair = ACCENT_PAIRS[normalized] || hexToSoftBorder(accent);
  return {
    accent,
    accentSoft: pair.soft,
    accentBorder: pair.border,
    textPrimary: '#0f172a',
    textSecondary: '#475569',
    textMuted: '#64748b',
    border: '#e2e8f0',
    warningBg: '#fefce8',
    warningBorder: '#fde047',
    reflectionBg: '#f5f3ff',
    reflectionBorder: '#ddd6fe',
  };
}

// Lightweight fallback: turn a hex into a very soft and slightly stronger tint
function hexToSoftBorder(hex) {
  try {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    // Mix toward white at 92% and 75% to make soft and border tints
    const mix = (v, pct) => Math.round(v + (255 - v) * pct);
    const soft   = `#${[mix(r, 0.92), mix(g, 0.92), mix(b, 0.92)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
    const border = `#${[mix(r, 0.75), mix(g, 0.75), mix(b, 0.75)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
    return { soft, border };
  } catch (_) {
    return { soft: '#eef2ff', border: '#c7d2fe' };
  }
}

export function renderLessonHTML(lesson, theme, opts = {}) {
  const T = theme;
  const { summary, keyTakeaways = [], sections = [], proTip, reflection } = lesson;
  const { workbookUrl } = opts;   // optional: URL of the lesson's workbook PDF in CC360 media library

  const summaryBlock = summary
    ? `<p style="font-size:18px;line-height:1.6;color:${T.textSecondary};margin:0 0 32px 0;font-style:italic;border-left:3px solid ${T.accent};padding-left:16px;">${escapeHtml(summary)}</p>`
    : '';

  const takeawaysBlock = keyTakeaways.length
    ? `<div style="background:${T.accentSoft};border:1px solid ${T.accentBorder};border-radius:8px;padding:20px 24px;margin:0 0 32px 0;">
         <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${T.accent};margin-bottom:12px;">★ Key Takeaways</div>
         <ul style="margin:0;padding-left:20px;color:${T.textPrimary};line-height:1.7;">
           ${keyTakeaways.map(t => `<li style="margin-bottom:6px;">${escapeHtml(t)}</li>`).join('')}
         </ul>
       </div>`
    : '';

  const sectionsBlock = sections.map((s, i) => `
    <div style="margin:0 0 28px 0;">
      <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:10px;">
        <span style="display:inline-block;min-width:28px;height:28px;line-height:28px;text-align:center;background:${T.accent};color:#ffffff;border-radius:14px;font-size:13px;font-weight:700;padding:0 10px;">${i + 1}</span>
        <h2 style="font-size:22px;font-weight:700;color:${T.textPrimary};margin:0;line-height:1.3;">${escapeHtml(s.heading || '')}</h2>
      </div>
      <p style="font-size:16px;line-height:1.7;color:${T.textPrimary};margin:0 0 0 40px;">${s.body || ''}</p>
    </div>
  `).join('');

  const proTipBlock = proTip
    ? `<div style="background:${T.warningBg};border-left:4px solid ${T.warningBorder};border-radius:4px;padding:16px 20px;margin:32px 0 0 0;">
         <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#a16207;margin-bottom:6px;">💡 Pro Tip</div>
         <p style="font-size:15px;line-height:1.6;color:${T.textPrimary};margin:0;">${escapeHtml(proTip)}</p>
       </div>`
    : '';

  const reflectionBlock = reflection
    ? `<div style="background:${T.reflectionBg};border:1px dashed ${T.reflectionBorder};border-radius:8px;padding:20px 24px;margin:24px 0 0 0;text-align:center;">
         <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6d28d9;margin-bottom:8px;">Reflect</div>
         <p style="font-size:17px;line-height:1.5;color:${T.textPrimary};margin:0;font-style:italic;">${escapeHtml(reflection)}</p>
       </div>`
    : '';

  const workbookBlock = workbookUrl
    ? `<div style="margin:40px 0 0 0;text-align:center;">
         <a href="${escapeAttr(workbookUrl)}" target="_blank" rel="noopener" style="display:inline-block;background:${T.accent};color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:16px 36px;border-radius:8px;letter-spacing:0.02em;box-shadow:0 4px 12px rgba(0,0,0,0.08);">
           📄 Download Lesson Workbook (PDF)
         </a>
         <div style="font-size:13px;color:${T.textMuted};margin-top:10px;">Printable workbook with questions, action items, and reflection prompts</div>
       </div>`
    : '';

  return `<div style="max-width:760px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${T.textPrimary};">
${summaryBlock}${takeawaysBlock}${sectionsBlock}${proTipBlock}${reflectionBlock}${workbookBlock}
</div>`;
}

export function escapeAttr(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
