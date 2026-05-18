// ───────────────────────────────────────────────────────────────────
// lib/funnel-themes.js
// Single source of truth for the 5 themed funnel templates.
//
// Each theme maps to:
//   • a funnelId        — the source funnel in the agency template sub-account
//                          (used by the funnel-share / clone endpoint)
//   • a snapshotId      — the corresponding agency snapshot (legacy; the
//                          snapshot path produces broken funnels and is
//                          superseded by funnel-share, but we keep the IDs
//                          for diagnostic/fallback purposes)
//   • a 4-color palette — used by the preview UI for instant re-skinning
//
// IMPORTANT — funnel IDs may be stale:
//   The funnelIds below were extracted from earlier set_assets_to_locations
//   cURL captures. If you've since regenerated/renamed your themed funnels,
//   these may point to the wrong template. To verify: open each themed
//   funnel in CC360 and check the URL — the segment after /funnels/ is the
//   funnelId. Update the values here if any differ.
// ───────────────────────────────────────────────────────────────────

export const THEMES = {
  ocean: {
    name: 'Ocean',
    funnelId:   'LQ8EXH9fb90ihUaFFy3l',   // verify in CC360 → Sites → Funnels → URL
    snapshotId: 'IS6WVR6kyTFvesxDUQwX',   // legacy; not used by share-clone path
    primary: '#2563eb',
    soft:    '#bfdbfe',
    tint:    '#eff6ff',
    dark:    '#0a1c3d',
  },
  emerald: {
    name: 'Emerald',
    funnelId:   '9ER1a9UTltCLILMwfOUr',
    snapshotId: 'Ogej5XirDM6WWZbYyXtR',
    primary: '#10b981',
    soft:    '#a7f3d0',
    tint:    '#ecfdf5',
    dark:    '#022c22',
  },
  amber: {
    name: 'Amber',
    funnelId:   'nMLWK4PcpmWVvRPs8Zvj',
    snapshotId: 'BbKCc9s7O3b41Bvmr6Wj',
    primary: '#f59e0b',
    soft:    '#fde68a',
    tint:    '#fffbeb',
    dark:    '#451a03',
  },
  rose: {
    name: 'Rose',
    funnelId:   'WIFCwHXRlmP0dYVoN6Ow',
    snapshotId: 'whQodmcyc65GBZknPCIL',
    primary: '#f43f5e',
    soft:    '#fecdd3',
    tint:    '#fff1f2',
    dark:    '#4c0519',
  },
  slate: {
    name: 'Slate',
    funnelId:   'OCqY2O2n8G69Hq4tIVck',
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