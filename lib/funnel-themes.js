// ───────────────────────────────────────────────────────────────────
// lib/funnel-themes.js
// Single source of truth for the 5 themed funnel templates.
//
// Each theme maps to:
//   • a CC360 funnel template snapshot ID (used by the snapshot-import endpoint)
//   • a 4-color palette (used by the preview UI for instant re-skinning)
//
// To add or change a theme, edit this file only.
// ───────────────────────────────────────────────────────────────────

export const THEMES = {
  ocean: {
    name: 'Ocean',
    snapshotId: 'X8njzRusxrZrcPJK462V',
    primary: '#2563eb',
    soft:    '#bfdbfe',
    tint:    '#eff6ff',
    dark:    '#0a1c3d',
  },
  emerald: {
    name: 'Emerald',
    snapshotId: 'yCMZmN6CGLVplZwAfYSx',
    primary: '#10b981',
    soft:    '#a7f3d0',
    tint:    '#ecfdf5',
    dark:    '#022c22',
  },
  amber: {
    name: 'Amber',
    snapshotId: 'kaOVcIdVpknOS2M3EssO',
    primary: '#f59e0b',
    soft:    '#fde68a',
    tint:    '#fffbeb',
    dark:    '#451a03',
  },
  rose: {
    name: 'Rose',
    snapshotId: 'XXwAC37Me2JlZF53xNf5',
    primary: '#f43f5e',
    soft:    '#fecdd3',
    tint:    '#fff1f2',
    dark:    '#4c0519',
  },
  slate: {
    name: 'Slate',
    snapshotId: '7om3Nv8KbbTYTwwSYMz7',
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
