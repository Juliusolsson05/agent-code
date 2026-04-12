// Settings store: theme mode (dark/light), accent color, and visibility
// toggles for the live terminal preview and system events. Deliberately
// simple — no opinionated theme variants, just two modes plus an accent
// picker the user drives themselves.
//
// Why accent is a single color set via inline style on <html> rather
// than a data attribute with preset CSS blocks:
//   If we kept a hardcoded palette in CSS, adding a color would mean
//   touching CSS. A single CSS custom property mutated at runtime lets
//   us ship as many presets as we want from TypeScript without touching
//   styles.css, and would also make user-picked arbitrary colors trivial
//   later. Today we expose a preset palette, but the plumbing doesn't
//   care.

export type ThemeMode = 'dark' | 'light'
export type AccentId =
  | 'lime'
  | 'amber'
  | 'sky'
  | 'magenta'
  | 'gold'
  | 'coral'
  | 'sage'
  | 'lavender'

export type AccentMeta = {
  id: AccentId
  name: string
  /** RGB hex for each mode so the swatch stays legible on both backgrounds. */
  dark: string
  light: string
  /** Contrast text color for use on solid accent backgrounds (buttons). */
  fgDark: string
  fgLight: string
}

export const ACCENTS: AccentMeta[] = [
  { id: 'lime',     name: 'Lime',     dark: '#7dd3a0', light: '#4b8a63', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'amber',    name: 'Amber',    dark: '#ff9f4a', light: '#b05d14', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'sky',      name: 'Sky',      dark: '#6bb6ff', light: '#2c6bb5', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'magenta',  name: 'Magenta',  dark: '#e66ed9', light: '#a23895', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'gold',     name: 'Gold',     dark: '#f5d64a', light: '#9a7c16', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'coral',    name: 'Coral',    dark: '#ff6b6b', light: '#b83c3c', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'sage',     name: 'Sage',     dark: '#a8c49a', light: '#5f7a52', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'lavender', name: 'Lavender', dark: '#b5a3ff', light: '#6e57c7', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
]

export type Settings = {
  mode: ThemeMode
  accent: AccentId
  showTerminalPreview: boolean
  showSystemEvents: boolean
  /**
   * High contrast override: pure #000 canvas + #fff ink, regardless of
   * mode. Overrides the mode token block via a higher-cascade CSS rule
   * keyed on `[data-contrast="high"]`. Orthogonal to `mode` — we keep
   * mode around so toggling contrast off returns to whatever mode the
   * user had selected.
   */
  highContrast: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'dark',
  accent: 'lime',
  showTerminalPreview: false,
  showSystemEvents: false,
  highContrast: false,
}

const STORAGE_KEY = 'cc-shell:settings'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        // Validate enums so a stale / tampered value can't break the app.
        mode: parsed.mode === 'light' ? 'light' : 'dark',
        accent: ACCENTS.some(a => a.id === parsed.accent)
          ? (parsed.accent as AccentId)
          : DEFAULT_SETTINGS.accent,
        highContrast: parsed.highContrast === true,
      }
    }
  } catch {
    // localStorage may be unavailable in hardened Electron modes — fall
    // through to defaults.
  }
  return DEFAULT_SETTINGS
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // see loadSettings
  }
}

/**
 * Apply mode + accent to the <html> element. Mode flips data-mode (which
 * cascades the mode-scoped CSS block). Accent writes the single custom
 * property both tokens read from. Called at module-eval time (for the
 * initial paint) and again any time the user changes settings.
 */
export function applyTheme(s: Settings): void {
  const root = document.documentElement
  root.dataset.mode = s.mode
  // High-contrast flag is written as a separate data attribute so the
  // corresponding CSS block (see styles.css) can override the mode
  // tokens without touching the mode value itself — that way toggling
  // contrast off falls right back into the user's saved mode.
  if (s.highContrast) {
    root.dataset.contrast = 'high'
  } else {
    delete root.dataset.contrast
  }
  const accent = ACCENTS.find(a => a.id === s.accent) ?? ACCENTS[0]
  const hex = s.mode === 'dark' ? accent.dark : accent.light
  const fg = s.mode === 'dark' ? accent.fgDark : accent.fgLight
  root.style.setProperty('--theme-accent', hex)
  root.style.setProperty('--theme-accent-fg', fg)
  window.dispatchEvent(new CustomEvent('cc-shell:theme-changed', { detail: s }))
}
