import {
  ACCENTS,
  CORNER_STYLES,
  DEFAULT_SETTINGS,
  FONT_FAMILIES,
  isBuiltInThemeMode,
  isDarkThemeMode,
} from '@renderer/app-state/settings/types'
import type { Settings } from '@renderer/app-state/settings/types'
import {
  CUSTOM_APPEARANCE_COLOR_KEYS,
  CUSTOM_APPEARANCE_CSS_VARS,
  parseCustomAppearanceJson,
} from '@renderer/app-state/settings/customAppearance'
import type { CustomAppearanceColors } from '@renderer/app-state/settings/customAppearance'
import {
  findSavedTheme,
  isSavedThemeId,
  resolveSavedThemeColors,
} from '@renderer/app-state/settings/savedThemes'
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
// The three semantic radius tokens. Exported so the applyTheme test can assert
// the contract by name instead of restating the literal strings, and so a
// rename cannot silently half-land.
export const CORNER_CHIP_CSS_VAR = '--theme-radius-chip'
export const CORNER_CONTROL_CSS_VAR = '--theme-radius-control'
export const CORNER_SLAB_CSS_VAR = '--theme-radius-slab'
export const CORNER_FLOAT_CSS_VAR = '--theme-radius-float'

const FALLBACK_APP_FONT_FAMILY =
  "'JetBrains Mono', ui-monospace, Menlo, Monaco, monospace"

// The seam between "which theme" and "what colors". Returns null for built-in
// modes, meaning "no inline overrides — let the [data-mode] CSS block win and
// run the accent path".
//
// WHY a dangling theme id falls back to null rather than to the legacy custom
// payload: a saved theme id can outlive its theme (deleted in another window,
// or a Settings blob synced from a machine with different themes). The safe
// degradation is a built-in theme that definitely renders, not a
// half-remembered palette the user may never have seen.
export function resolveThemePayload(settings: Settings): CustomAppearanceColors | null {
  if (isSavedThemeId(settings.mode)) {
    const theme = findSavedTheme(settings.savedThemes, settings.mode)
    if (!theme) return null
    return resolveSavedThemeColors(theme)
  }
  // Transitional: a v4 blob that somehow skipped migration can still say
  // 'custom'. coerceSettings converts those into a real saved theme, so this
  // branch should be unreachable in practice — it exists so a partially
  // migrated state still renders the user's colors instead of silently
  // reverting them to Dark.
  if (settings.mode === 'custom') {
    try {
      return parseCustomAppearanceJson(settings.customAppearanceJson)
    } catch {
      return null
    }
  }
  return null
}

export function applyTheme(settings: Settings): void {
  // Renderer capability registries are also consumed by Node-side replay,
  // policy, and transcript tests. A presentational component may therefore
  // pull the settings store into a graph that has no DOM. Theme application
  // is a browser side effect, not a module-import precondition; keeping the
  // guard here preserves one source of truth for every caller instead of
  // forcing each pure consumer to mock `document` merely to inspect policy.
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const root = document.documentElement
  const payload = resolveThemePayload(settings)
  // WHY data-mode is never allowed to hold a raw `theme:<uuid>`:
  //
  // With a payload, 'custom' is written because the 81 inline properties fully
  // define the palette; the literal keeps existing [data-mode="custom"] styling
  // and debug tooling working without teaching them about uuids.
  //
  // WITHOUT a payload (a theme id that no longer resolves), writing the id
  // through would put a value in data-mode that matches no CSS block. That is
  // not a black screen — `:root` doubles as the dark palette — but every
  // high-contrast rule is a compound selector
  // ([data-contrast="high"][data-mode="dark"] and friends), so all of them miss
  // and high contrast silently switches off while its toggle still reads on.
  // No in-app sequence reaches this today (delete resets mode, coerceSettings
  // repairs at boot, the editor validates before save) — but applyTheme is
  // called by the phone client on an UNCOERCED blob, so this is the one place
  // that has to be defensive on its own.
  const mode = payload
    ? 'custom'
    : isBuiltInThemeMode(settings.mode) ? settings.mode : DEFAULT_SETTINGS.mode
  root.dataset.mode = mode
  root.dataset.contrast = settings.contrast ? 'high' : 'normal'
  if (payload) {
    applyCustomAppearance(root, payload)
  } else {
    clearCustomAppearance(root)
    const accent = ACCENTS.find(a => a.id === settings.accent) ?? ACCENTS[0]
    const dark = isDarkThemeMode(mode)
    root.style.setProperty('--theme-accent', dark ? accent.dark : accent.light)
    root.style.setProperty('--theme-accent-fg', dark ? accent.fgDark : accent.fgLight)
  }
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
  // Corner radius: three lengths written inline for the same reason the accent
  // and font tokens are — inline custom properties on <html> outrank the
  // [data-mode] blocks, so the whole app's `rounded-chip/slab/float` utilities
  // re-resolve with no React work and no per-component subscription.
  //
  // WHY the `?? CORNER_STYLES[0]` fallback repeats the font lookup's shape
  // rather than trusting coerceSettings: this function is also called by the
  // phone client on an UNCOERCED settings blob (see the data-mode comment
  // above). Resolving to undefined here would write three invalid values and
  // break every rounded surface at once, so the defensive read stays local.
  //
  // All four are always written together. A partially applied tier is the
  // shape a copy-paste error takes here, and it produces an app whose chips
  // and panels disagree about the corner language.
  const corners =
    CORNER_STYLES.find(c => c.id === settings.cornerStyle) ?? CORNER_STYLES[0]
  root.style.setProperty(CORNER_CHIP_CSS_VAR, corners.chip)
  root.style.setProperty(CORNER_CONTROL_CSS_VAR, corners.control)
  root.style.setProperty(CORNER_SLAB_CSS_VAR, corners.slab)
  root.style.setProperty(CORNER_FLOAT_CSS_VAR, corners.float)
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: settings }))
}

function applyCustomAppearance(root: HTMLElement, colors: CustomAppearanceColors): void {
  // WHY custom mode writes every color token inline instead of generating a
  // stylesheet block: the built-in themes are static CSS keyed by
  // `[data-mode]`, but user JSON is runtime data from persisted settings.
  // Inline custom properties on `<html>` are the same mechanism the existing
  // accent picker already uses, and they deliberately outrank the mode blocks
  // in styles.css. That gives live updates with zero React re-render plumbing
  // and keeps Monaco/xterm listeners on the existing theme-changed event.
  //
  // Parsing moved out to resolveThemePayload so there is exactly one place
  // that decides which palette is active; this function only writes.
  for (const key of CUSTOM_APPEARANCE_COLOR_KEYS) {
    root.style.setProperty(CUSTOM_APPEARANCE_CSS_VARS[key], colors[key])
  }
}

function clearCustomAppearance(root: HTMLElement): void {
  // WHY clear all color tokens when leaving custom mode: custom mode applies
  // values as inline styles, and inline styles beat every `[data-mode]` CSS
  // rule. If we only changed `data-mode`, the old custom palette would keep
  // winning and every built-in theme would look broken until reload.
  for (const key of CUSTOM_APPEARANCE_COLOR_KEYS) {
    root.style.removeProperty(CUSTOM_APPEARANCE_CSS_VARS[key])
  }
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
