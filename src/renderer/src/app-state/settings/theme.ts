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

// CSS variable consumed by the `font-code` Tailwind utility (defined
// in styles.css via `@theme inline { --font-code: var(--theme-font-code) }`).
// Also read by xterm panes via `getActiveCodeFontFamily()` below so a
// single applyTheme call updates BOTH the CSS chrome and the canvas-
// rendered terminals.
const CODE_FONT_CSS_VAR = '--theme-font-code'

// Fallback string used when:
//   - `getActiveCodeFontFamily()` is called before applyTheme has run
//     for the first time (e.g. an early xterm mount).
//   - `--theme-font-code` is set to an empty string due to a bad
//     migration or a deliberate clear.
// Matches the historical default (JetBrains Mono with system-mono
// fallbacks) so reading this in a degenerate state always produces a
// visually-correct monospace face.
const FALLBACK_CODE_FONT_FAMILY =
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
  // Font family: the user-visible picker resolves to a curated meta
  // entry whose `family` is a complete CSS font-family declaration
  // (including fallbacks). Setting the variable here is enough for
  // every chrome surface (they read via `font-code`) — xterm panes
  // listen to the `agent-code:theme-changed` event below and re-read
  // via `getActiveCodeFontFamily()`.
  const fontMeta =
    FONT_FAMILIES.find(f => f.id === settings.fontFamily) ?? FONT_FAMILIES[0]
  root.style.setProperty(CODE_FONT_CSS_VAR, fontMeta.family)
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: settings }))
}

// Read the currently-active code font family as a CSS font-family
// string. Source of truth for xterm.js instances which can't see CSS
// variables (canvas rendering).
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
// Returns the fallback declaration when the variable is unset (early
// boot) or empty (bad state). Callers should not have to defensively
// check for an empty string.
export function getActiveCodeFontFamily(): string {
  if (typeof document === 'undefined') return FALLBACK_CODE_FONT_FAMILY
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(CODE_FONT_CSS_VAR)
    .trim()
  return value || FALLBACK_CODE_FONT_FAMILY
}
