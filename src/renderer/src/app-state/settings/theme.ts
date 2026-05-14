import {
  ACCENTS,
  FONT_FAMILIES,
  isDarkThemeMode,
  type Settings,
} from '@renderer/app-state/settings/types'
import { APP_SLUG } from '@shared/appIdentity'

// Event name fired on `window` after every applyTheme run. Subscribers
// (currently: xterm panes that can't see CSS variables) re-read state
// from the DOM in response. Exported so subscribers don't have to
// know about APP_SLUG just to compose the right event name.
export const THEME_CHANGED_EVENT = `${APP_SLUG}:theme-changed`

// CSS variable consumed by the entire renderer. Normal DOM surfaces inherit
// it from html/body/#root, Tailwind's historical `font-code` utility aliases
// to it, and canvas-backed surfaces (xterm + Monaco) read it through
// getActiveAppFontFamily() because they do not reliably inherit DOM fonts.
const APP_FONT_CSS_VAR = '--theme-app-font'

// Compatibility alias for the original PR. A lot of existing CSS and comments
// still say "code" because the app is intentionally monospace everywhere, but
// the product behavior must be global: one picker changes every app font. Keep
// this variable in sync so any old `font-code` utility or external debug CSS
// continues to render with the selected app font while the clearer app token
// becomes the source of truth going forward.
const LEGACY_CODE_FONT_CSS_VAR = '--theme-font-code'

// Fallback string used when:
//   - `getActiveAppFontFamily()` is called before applyTheme has run
//     for the first time (e.g. an early xterm/Monaco mount).
//   - `--theme-app-font` is set to an empty string due to a bad
//     migration or a deliberate clear.
// Matches the historical default (JetBrains Mono with system-mono
// fallbacks) so reading this in a degenerate state always produces a
// visually-correct monospace face.
const FALLBACK_APP_FONT_FAMILY =
  "'JetBrains Mono', ui-monospace, Menlo, Monaco, monospace"

export function applyTheme(settings: Settings): void {
  const root = document.documentElement
  root.dataset.mode = settings.mode
  root.dataset.contrast = settings.contrast ? 'high' : 'normal'
  const accent = ACCENTS.find(a => a.id === settings.accent) ?? ACCENTS[0]
  const hex = isDarkThemeMode(settings.mode) ? accent.dark : accent.light
  const fg = isDarkThemeMode(settings.mode) ? accent.fgDark : accent.fgLight
  root.style.setProperty('--theme-accent', hex)
  root.style.setProperty('--theme-accent-fg', fg)
  // Font family: the user-visible picker resolves to a curated meta entry
  // whose `family` is a complete CSS font-family declaration (including
  // fallbacks). We write both the new global token and the old code-token
  // alias because the app has historically named its one global monospace
  // utility `font-code`. The setting is NOT code-only: html/body/#root,
  // form controls, chrome, Monaco, and xterm all read the same resolved value.
  const fontMeta =
    FONT_FAMILIES.find(f => f.id === settings.fontFamily) ?? FONT_FAMILIES[0]
  root.style.setProperty(APP_FONT_CSS_VAR, fontMeta.family)
  root.style.setProperty(LEGACY_CODE_FONT_CSS_VAR, fontMeta.family)
  root.style.setProperty('--monaco-monospace-font', fontMeta.family)
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: settings }))
}

// Read the currently-active application font family as a CSS font-family
// string. Source of truth for xterm.js and Monaco instances, which either
// render to canvas or cache font metrics and therefore cannot be trusted to
// react to inherited CSS alone.
//
// WHY route through the CSS variable instead of the Settings store:
//   1. Decouples xterm components from the settings store — they can
//      stay pure presentational and don't have to thread `settings`
//      through props or import the zustand store.
//   2. Guarantees consistency with the chrome's actual rendered font
//      at the moment of read — if a future caller mutates the variable
//      directly (e.g. a debug command), xterm reflects that immediately.
//   3. Lets the existing `agent-code:theme-changed` event drive xterm
//      updates without inventing a new font-specific event.
//
// Returns the fallback declaration when the variable is unset (early boot) or
// empty (bad state). Callers should not have to defensively check for an empty
// string.
export function getActiveAppFontFamily(): string {
  if (typeof document === 'undefined') return FALLBACK_APP_FONT_FAMILY
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(APP_FONT_CSS_VAR)
    .trim()
  return value || FALLBACK_APP_FONT_FAMILY
}

// Backward-compatible name for code that still talks in terms of "code font".
// The selected font is global, not code-only; keep this alias until all older
// references naturally disappear in nearby edits.
export const getActiveCodeFontFamily = getActiveAppFontFamily
