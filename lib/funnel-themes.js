// ───────────────────────────────────────────────────────────────────
// lib/funnel-themes.js
// Single source of truth for the 5 themed funnel templates.
//
// Each theme maps to:
//   • a CC360 snapshot ID (the source template, agency-owned)
//   • a 4-color palette (used by the preview UI for instant re-skinning)
//
// All 5 snapshots share the same set of 128 custom-value IDs (Tony reused
// the same merge-tag custom values across themes). Each snapshot has its
// own funnel ID. We don't hardcode either list here — the snapshot-push
// flow fetches them at runtime via GET /snapshots-appengine/snapshot/{id}/get_assets
// so adding/removing assets to a snapshot doesn't require code changes.
//
// To add or change a theme, edit this file only.
// ───────────────────────────────────────────────────────────────────

export const THEMES = {
  ocean: {
    name: 'Ocean',
    snapshotId: 'IS6WVR6kyTFvesxDUQwX',
    primary: '#2563eb',
    soft:    '#bfdbfe',
    tint:    '#eff6ff',
    dark:    '#0a1c3d',
  },
  emerald: {
    name: 'Emerald',
    snapshotId: 'Ogej5XirDM6WWZbYyXtR',
    primary: '#10b981',
    soft:    '#a7f3d0',
    tint:    '#ecfdf5',
    dark:    '#022c22',
  },
  amber: {
    name: 'Amber',
    snapshotId: 'BbKCc9s7O3b41Bvmr6Wj',
    primary: '#f59e0b',
    soft:    '#fde68a',
    tint:    '#fffbeb',
    dark:    '#451a03',
  },
  rose: {
    name: 'Rose',
    snapshotId: 'whQodmcyc65GBZknPCIL',
    primary: '#f43f5e',
    soft:    '#fecdd3',
    tint:    '#fff1f2',
    dark:    '#4c0519',
  },
  slate: {
    name: 'Slate',
    snapshotId: 'wdYWmS5EFsjuyHAYfgYB',
    primary: '#475569',
    soft:    '#cbd5e1',
    tint:    '#f1f5f9',
    dark:    '#0f172a',
  },
};

export const DEFAULT_THEME = 'ocean';

export function getTheme(key) {
  return THEMES[key] || THEMES[DEFAULT_THEME];
}

export function isValidTheme(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(THEMES, key);
}

export function listThemeKeys() {
  return Object.keys(THEMES);
}