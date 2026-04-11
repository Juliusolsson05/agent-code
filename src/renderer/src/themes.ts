// Theme registry — UI metadata only. The actual colors live in
// src/renderer/src/styles.css where each `[data-theme="..."]` block
// sets CSS custom properties. This file exists so the ThemePicker can
// render previews and a dropdown without hardcoding theme-specific
// knowledge. Adding a theme = add a block in styles.css + append an
// entry here.
//
// Why the swatches are hardcoded duplicates of the CSS values:
// the picker needs to preview themes WITHOUT activating them (so the
// user can browse before committing). The only way to read a CSS
// variable from a theme you're not currently using is to instantiate
// a hidden element with that data-theme and read computed styles —
// heavyweight. A typed `swatches` array is 8 lines, type-safe, and
// obviously right.

export type ThemeId = 'noir' | 'paper' | 'phosphor' | 'ember'

export type ThemeMeta = {
  id: ThemeId
  /** Display name shown in the picker. */
  name: string
  /** One-line description of the mood / direction. */
  blurb: string
  /** Three preview swatch colors: [canvas, ink, accent]. Used in the
   *  picker swatch squares. Keep in sync with styles.css. */
  swatches: [string, string, string]
  /** Name of the display font stack used by this theme, shown in the
   *  picker so the user can see the typographic identity at a glance. */
  displayFont: string
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'noir',
    name: 'Noir',
    blurb: 'Editorial dark. Carbon + cream, Fraunces display, electric lime.',
    swatches: ['#09090b', '#ebe5d9', '#c8ff5a'],
    displayFont: 'Fraunces',
  },
  {
    id: 'paper',
    name: 'Paper',
    blurb: 'Warm notebook. Cream + charcoal, Instrument Serif, oxblood.',
    swatches: ['#f4eedb', '#1c1612', '#8b2635'],
    displayFont: 'Instrument Serif',
  },
  {
    id: 'phosphor',
    name: 'Phosphor',
    blurb: 'Vintage CRT. Green-on-black, all Space Mono, subtle scanlines.',
    swatches: ['#050a05', '#8ae88a', '#c8ff5a'],
    displayFont: 'Space Mono',
  },
  {
    id: 'ember',
    name: 'Ember',
    blurb: 'Warm drama. Brown-black + cream, Playfair Display, ember red.',
    swatches: ['#130c0a', '#f0e6d8', '#ff5c35'],
    displayFont: 'Playfair Display',
  },
]

export const DEFAULT_THEME: ThemeId = 'noir'

const STORAGE_KEY = 'cc-shell:theme'

/**
 * Read the persisted theme choice from localStorage, falling back to the
 * default. Validated against THEMES so a stale/tampered value can't break
 * the app — anything unknown falls back.
 */
export function loadThemeFromStorage(): ThemeId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw && THEMES.some(t => t.id === raw)) return raw as ThemeId
  } catch {
    // localStorage may be unavailable (e.g. incognito / hardened mode).
    // Silently fall through to the default.
  }
  return DEFAULT_THEME
}

/**
 * Persist + apply a theme. The apply step sets `data-theme` on the
 * document root which triggers every theme-token CSS variable to
 * cascade through the whole DOM — no React re-render required for
 * the paint, just for any components that want to show the current
 * theme ID in their UI (the picker label, for instance).
 */
export function applyTheme(id: ThemeId): void {
  document.documentElement.dataset.theme = id
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // see loadThemeFromStorage
  }
}
