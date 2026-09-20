import { CUSTOM_APPEARANCE_COLOR_KEYS } from '@shared/appearanceColors'
export { CUSTOM_APPEARANCE_COLOR_KEYS } from '@shared/appearanceColors'

export type CustomAppearanceColorKey = typeof CUSTOM_APPEARANCE_COLOR_KEYS[number]
export type CustomAppearanceColors = Record<CustomAppearanceColorKey, string>

export const CUSTOM_APPEARANCE_CSS_VARS: Record<CustomAppearanceColorKey, string> = {
  canvas: '--theme-canvas',
  surface: '--theme-surface',
  surfaceHi: '--theme-surface-hi',
  ink: '--theme-ink',
  inkDim: '--theme-ink-dim',
  muted: '--theme-muted',
  border: '--theme-border',
  borderHi: '--theme-border-hi',
  accent: '--theme-accent',
  accentFg: '--theme-accent-fg',
  accentSoft: '--theme-accent-soft',
  focusRing: '--theme-focus-ring',
  panelBg: '--theme-panel-bg',
  panelHeaderBg: '--theme-panel-header-bg',
  panelElevatedBg: '--theme-panel-elevated-bg',
  panelBorder: '--theme-panel-border',
  rowBg: '--theme-row-bg',
  rowHoverBg: '--theme-row-hover-bg',
  rowSelectedBg: '--theme-row-selected-bg',
  rowSelectedFg: '--theme-row-selected-fg',
  rowDangerSelectedBg: '--theme-row-danger-selected-bg',
  controlBg: '--theme-control-bg',
  controlHoverBg: '--theme-control-hover-bg',
  controlActiveBg: '--theme-control-active-bg',
  controlBorder: '--theme-control-border',
  controlBorderHover: '--theme-control-border-hover',
  controlFg: '--theme-control-fg',
  controlActiveFg: '--theme-control-active-fg',
  inputBg: '--theme-input-bg',
  inputBorder: '--theme-input-border',
  inputBorderFocus: '--theme-input-border-focus',
  inputPlaceholder: '--theme-input-placeholder',
  tabBg: '--theme-tab-bg',
  tabActiveBg: '--theme-tab-active-bg',
  tabHoverBg: '--theme-tab-hover-bg',
  tabAccent: '--theme-tab-accent',
  popoverBg: '--theme-popover-bg',
  popoverBorder: '--theme-popover-border',
  overlayScrim: '--theme-overlay-scrim',
  overlayScrimStrong: '--theme-overlay-scrim-strong',
  shadowColor: '--theme-shadow-color',
  codeBg: '--theme-code-bg',
  codeBorder: '--theme-code-border',
  codeCurrentLineBg: '--theme-code-current-line-bg',
  codeSelectionBg: '--theme-code-selection-bg',
  codeSelectionInactiveBg: '--theme-code-selection-inactive-bg',
  codeScrollbarBg: '--theme-code-scrollbar-bg',
  codeScrollbarHoverBg: '--theme-code-scrollbar-hover-bg',
  codeScrollbarActiveBg: '--theme-code-scrollbar-active-bg',
  editorBg: '--theme-editor-bg',
  editorFg: '--theme-editor-fg',
  editorCurrentLineBg: '--theme-editor-current-line-bg',
  editorSelectionBg: '--theme-editor-selection-bg',
  editorSelectionInactiveBg: '--theme-editor-selection-inactive-bg',
  editorScrollbarBg: '--theme-editor-scrollbar-bg',
  editorScrollbarHoverBg: '--theme-editor-scrollbar-hover-bg',
  editorScrollbarActiveBg: '--theme-editor-scrollbar-active-bg',
  danger: '--theme-danger',
  dangerFg: '--theme-danger-fg',
  dangerSoft: '--theme-danger-soft',
  dangerBorder: '--theme-danger-border',
  success: '--theme-success',
  successFg: '--theme-success-fg',
  successSoft: '--theme-success-soft',
  successBorder: '--theme-success-border',
  warning: '--theme-warning',
  warningFg: '--theme-warning-fg',
  warningSoft: '--theme-warning-soft',
  warningBorder: '--theme-warning-border',
  info: '--theme-info',
  infoFg: '--theme-info-fg',
  infoSoft: '--theme-info-soft',
  infoBorder: '--theme-info-border',
  codeInk: '--theme-code-ink',
  codeInkDim: '--theme-code-ink-dim',
  userBg: '--theme-user-bg',
  toolBg: '--theme-tool-bg',
  diffAddBg: '--theme-diff-add-bg',
  diffRemoveBg: '--theme-diff-remove-bg',
  diffAddFg: '--theme-diff-add-fg',
  diffRemoveFg: '--theme-diff-remove-fg',
}

// The Nord palette (#973) — identical to the `dark-nord` CSS blocks in
// styles.css. This is the value a sparse saved or extension theme inherits
// for any token it omits, and the legacy `customAppearanceJson` seed, so it
// must track the DEFAULT built-in theme: a sparse theme backfilled with a
// palette the app no longer ships would look like a bug in the theme, not in
// the backfill.
export const DEFAULT_CUSTOM_APPEARANCE: CustomAppearanceColors = {
  canvas: '#171b21',
  surface: '#20242d',
  surfaceHi: '#262b35',
  ink: '#d8dee9',
  inkDim: 'rgba(216, 222, 233, 0.68)',
  muted: 'rgba(216, 222, 233, 0.42)',
  border: '#262b35',
  borderHi: '#3b4252',
  accent: '#88c0d0',
  accentFg: '#171b21',
  accentSoft: 'rgba(136, 192, 208, 0.14)',
  focusRing: '#88c0d0',
  panelBg: '#20242d',
  panelHeaderBg: '#20242d',
  panelElevatedBg: '#262b35',
  panelBorder: '#2e3440',
  rowBg: 'transparent',
  rowHoverBg: 'rgba(46, 52, 64, 0.75)',
  rowSelectedBg: 'rgba(136, 192, 208, 0.16)',
  rowSelectedFg: '#eceff4',
  rowDangerSelectedBg: 'rgba(191, 97, 106, 0.20)',
  controlBg: '#262b35',
  controlHoverBg: '#2e3440',
  controlActiveBg: '#88c0d0',
  controlBorder: '#3b4252',
  controlBorderHover: '#4c566a',
  controlFg: '#d8dee9',
  controlActiveFg: '#171b21',
  inputBg: '#171b21',
  inputBorder: '#3b4252',
  inputBorderFocus: '#88c0d0',
  inputPlaceholder: 'rgba(216, 222, 233, 0.35)',
  tabBg: '#171b21',
  tabActiveBg: '#20242d',
  tabHoverBg: '#262b35',
  tabAccent: '#88c0d0',
  popoverBg: '#20242d',
  popoverBorder: '#3b4252',
  overlayScrim: 'rgba(13, 14, 18, 0.65)',
  overlayScrimStrong: 'rgba(13, 14, 18, 0.85)',
  shadowColor: 'rgba(13, 14, 18, 0.75)',
  codeBg: '#171b21',
  codeBorder: '#2e3440',
  codeCurrentLineBg: 'rgba(46, 52, 64, 0.70)',
  codeSelectionBg: 'rgba(136, 192, 208, 0.22)',
  codeSelectionInactiveBg: 'rgba(59, 66, 82, 0.55)',
  codeScrollbarBg: 'rgba(76, 86, 106, 0.45)',
  codeScrollbarHoverBg: 'rgba(94, 129, 172, 0.60)',
  codeScrollbarActiveBg: '#5e81ac',
  editorBg: '#171b21',
  editorFg: '#d8dee9',
  editorCurrentLineBg: 'rgba(46, 52, 64, 0.60)',
  editorSelectionBg: 'rgba(136, 192, 208, 0.20)',
  editorSelectionInactiveBg: 'rgba(59, 66, 82, 0.55)',
  editorScrollbarBg: 'rgba(76, 86, 106, 0.45)',
  editorScrollbarHoverBg: 'rgba(94, 129, 172, 0.60)',
  editorScrollbarActiveBg: '#5e81ac',
  danger: '#bf616a',
  dangerFg: '#171b21',
  dangerSoft: 'rgba(191, 97, 106, 0.15)',
  dangerBorder: 'rgba(191, 97, 106, 0.45)',
  success: '#a3be8c',
  successFg: '#171b21',
  successSoft: 'rgba(163, 190, 140, 0.15)',
  successBorder: 'rgba(163, 190, 140, 0.45)',
  warning: '#ebcb8b',
  warningFg: '#171b21',
  warningSoft: 'rgba(235, 203, 139, 0.15)',
  warningBorder: 'rgba(235, 203, 139, 0.45)',
  info: '#81a1c1',
  infoFg: '#171b21',
  infoSoft: 'rgba(129, 161, 193, 0.15)',
  infoBorder: 'rgba(129, 161, 193, 0.45)',
  codeInk: '#d8dee9',
  codeInkDim: 'rgba(216, 222, 233, 0.42)',
  userBg: 'rgba(94, 129, 172, 0.12)',
  toolBg: 'rgba(46, 52, 64, 0.55)',
  diffAddBg: 'rgba(163, 190, 140, 0.13)',
  diffRemoveBg: 'rgba(191, 97, 106, 0.13)',
  diffAddFg: '#a3be8c',
  diffRemoveFg: '#bf616a',
}

export const DEFAULT_CUSTOM_APPEARANCE_JSON = stringifyCustomAppearance(
  DEFAULT_CUSTOM_APPEARANCE,
)

const CUSTOM_APPEARANCE_COLOR_DESCRIPTIONS: Record<CustomAppearanceColorKey, string> = {
  canvas: 'Deepest app background. The workspace/editor canvas sits here; panels should be visibly above it.',
  surface: 'Normal chrome surface for bars, sidebars, and pane headers. Usually one step above canvas.',
  surfaceHi: 'Raised/hover chrome surface. Usually one small step above surface, not a second accent color.',
  ink: 'Primary text on canvas/surface backgrounds.',
  inkDim: 'Secondary text on canvas/surface backgrounds.',
  muted: 'Tertiary text, glyphs, disabled-ish metadata, and quiet dividers.',
  border: 'Default divider/border between adjacent flat surfaces.',
  borderHi: 'Higher-contrast border for hover, popovers, and emphasized boundaries.',
  accent: 'Primary interactive accent: focus, active markers, live status, links, and selected chrome.',
  accentFg: 'Text/icon color that sits directly on accent.',
  accentSoft: 'Low-emphasis accent wash for selected or highlighted areas that still need normal text.',
  focusRing: 'Focus outline color. Usually accent, but can be tuned separately for light themes.',
  panelBg: 'Default panel body background. Usually aliases surface; separate so sidebars can differ from canvas.',
  panelHeaderBg: 'Panel header/toolstrip background. Often equal to panelBg or slightly stronger.',
  panelElevatedBg: 'Raised panel background for nested controls and active regions. Usually surfaceHi.',
  panelBorder: 'Panel boundary color. Usually border, but light themes often need a slightly stronger edge.',
  rowBg: 'Resting row/list item background. Often transparent so the parent panel shows through.',
  rowHoverBg: 'Hover background for rows and menu items. Should be barely above rowBg.',
  rowSelectedBg: 'Selected row background. Should read selected without requiring a saturated accent fill.',
  rowSelectedFg: 'Text/icon color on rowSelectedBg.',
  rowDangerSelectedBg: 'Selected row background for destructive modes.',
  controlBg: 'Resting button/toggle/select background.',
  controlHoverBg: 'Button/toggle/select hover background.',
  controlActiveBg: 'Active selected control background.',
  controlBorder: 'Resting control border.',
  controlBorderHover: 'Hover/focusable control border before true focus.',
  controlFg: 'Resting control text/icon color.',
  controlActiveFg: 'Text/icon color on controlActiveBg.',
  inputBg: 'Text input and textarea background. Should contrast with panelBg but not look like a code slab.',
  inputBorder: 'Resting input border.',
  inputBorderFocus: 'Focused input border. Usually focusRing/accent.',
  inputPlaceholder: 'Placeholder text in inputs.',
  tabBg: 'Inactive tab background.',
  tabActiveBg: 'Active tab background. For editor tabs, this should relate to editorBg/canvas.',
  tabHoverBg: 'Inactive tab hover background.',
  tabAccent: 'Thin active-tab stripe or dirty/modified indicator.',
  popoverBg: 'Command palette, dropdown, and floating menu background.',
  popoverBorder: 'Boundary for floating menus and popovers.',
  overlayScrim: 'Modal backdrop over the app. Keep it color-only; box-shadow geometry is fixed by CSS.',
  overlayScrimStrong: 'Stronger modal backdrop for destructive or narrow-focus overlays.',
  shadowColor: 'Color used by fixed elevation shadows. Geometry stays in CSS; this only controls tint/opacity.',
  codeBg: 'Code slab background for transcript code blocks, diffs, and embedded code viewers. It may stay dark in light themes.',
  codeBorder: 'Border for code slabs. Should be visible against both codeBg and surrounding panels.',
  codeCurrentLineBg: 'Current-line background inside embedded code slabs.',
  codeSelectionBg: 'Selection background inside embedded code slabs. Must be legible over codeBg.',
  codeSelectionInactiveBg: 'Inactive selection background inside embedded code slabs.',
  codeScrollbarBg: 'Scrollbar thumb on embedded code slabs.',
  codeScrollbarHoverBg: 'Hovered scrollbar thumb on embedded code slabs.',
  codeScrollbarActiveBg: 'Dragged scrollbar thumb on embedded code slabs.',
  editorBg: 'Full file-editor background. Usually canvas, not codeBg, because the editor is the workspace itself.',
  editorFg: 'Full file-editor foreground.',
  editorCurrentLineBg: 'Current-line background in the full file editor. Should be subtle over editorBg.',
  editorSelectionBg: 'Selection background in the full file editor.',
  editorSelectionInactiveBg: 'Inactive selection background in the full file editor.',
  editorScrollbarBg: 'Scrollbar thumb in the full file editor.',
  editorScrollbarHoverBg: 'Hovered scrollbar thumb in the full file editor.',
  editorScrollbarActiveBg: 'Dragged scrollbar thumb in the full file editor.',
  danger: 'Destructive/error foreground and strong status color.',
  dangerFg: 'Text/icon color on danger.',
  dangerSoft: 'Low-emphasis destructive/error background.',
  dangerBorder: 'Destructive/error border.',
  success: 'Healthy/success foreground and strong status color.',
  successFg: 'Text/icon color on success.',
  successSoft: 'Low-emphasis success background.',
  successBorder: 'Success border.',
  warning: 'Warning foreground and strong status color.',
  warningFg: 'Text/icon color on warning.',
  warningSoft: 'Low-emphasis warning background.',
  warningBorder: 'Warning border.',
  info: 'Informational foreground and strong status color.',
  infoFg: 'Text/icon color on info.',
  infoSoft: 'Low-emphasis informational background.',
  infoBorder: 'Informational border.',
  codeInk: 'Primary text inside code slabs on codeBg.',
  codeInkDim: 'Secondary text inside code slabs on codeBg.',
  userBg: 'User prompt row background in the feed.',
  toolBg: 'Tool result row/slab background in the feed.',
  diffAddBg: 'Added-line background inside diff/code slabs.',
  diffRemoveBg: 'Removed-line background inside diff/code slabs.',
  diffAddFg: 'Added-line gutter/text accent inside diff/code slabs.',
  diffRemoveFg: 'Removed-line gutter/text accent inside diff/code slabs.',
}

export const CUSTOM_APPEARANCE_SCHEMA = {
  type: 'object',
  description:
    'Sparse Agent Code color-token object. Any omitted key inherits the built-in default for that token, so themes can customize only the relationships they care about.',
  additionalProperties: false,
  properties: Object.fromEntries(
    CUSTOM_APPEARANCE_COLOR_KEYS.map(key => [
      key,
      {
        type: 'string',
        minLength: 1,
        description: `${CUSTOM_APPEARANCE_COLOR_DESCRIPTIONS[key]} Hex, named colors, and common color functions such as rgb(), hsl(), oklch(), color(), and color-mix() are accepted.`,
      },
    ]),
  ),
}

export const CUSTOM_APPEARANCE_SCHEMA_JSON = JSON.stringify(
  CUSTOM_APPEARANCE_SCHEMA,
  null,
  2,
)

export function stringifyCustomAppearance(colors: CustomAppearanceColors): string {
  return JSON.stringify(colors, null, 2)
}

// WHY there are two strictnesses rather than one parser:
//
// The editor and the loader want opposite things from a bad key, and serving
// both from one function was a latent theme-destroying bug. In the EDITOR, a
// typo must be fatal — silently ignoring `"surfacce"` would render as "saved
// successfully" while that color never applies, which is exactly the
// unfalsifiable failure the strict check was added to prevent. At LOAD time
// the same fatality is catastrophic: coerceSavedThemes drops any theme whose
// JSON throws, so the day a product token is renamed, every *saved, named*
// theme still carrying the old key would be silently deleted at boot and the
// user dropped back to the default theme.
//
// That asymmetry was tolerable when custom appearance was one throwaway slot.
// Named themes are durable user-authored artifacts — and they are seeded dense
// with all 81 keys by readAppliedAppearance(), which maximizes the exposure. So
// the loader now keeps the theme and drops what it cannot understand.
export type CustomAppearanceParseMode = 'strict' | 'lenient'

export function parseCustomAppearanceJson(
  raw: string,
  mode: CustomAppearanceParseMode = 'strict',
): CustomAppearanceColors {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid JSON: ${message}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Custom appearance must be a JSON object.')
  }

  const lenient = mode === 'lenient'
  const record = parsed as Record<string, unknown>
  const allowed = new Set<string>(CUSTOM_APPEARANCE_COLOR_KEYS)
  const extra = Object.keys(record).filter(key => !allowed.has(key))
  // Structurally broken input (not JSON, not an object) still throws in both
  // modes — there is no theme to salvage. Only *recognition* failures degrade.
  if (extra.length > 0 && !lenient) {
    throw new Error(`Unknown custom appearance key: ${extra.join(', ')}`)
  }

  const colors = {} as CustomAppearanceColors
  for (const key of CUSTOM_APPEARANCE_COLOR_KEYS) {
    const value = record[key]
    // WHY missing keys are backfilled instead of making the whole custom
    // palette invalid: Custom Appearance is persisted user data, and new
    // product tokens are added over time. Treating a missing *new* key as a
    // fatal schema error would silently throw a user's old custom theme away
    // during coerceSettings().
    if (value === undefined) {
      colors[key] = DEFAULT_CUSTOM_APPEARANCE[key]
      continue
    }
    if (typeof value !== 'string') {
      if (lenient) {
        colors[key] = DEFAULT_CUSTOM_APPEARANCE[key]
        continue
      }
      throw new Error(`Custom appearance key "${key}" must be a string.`)
    }
    const trimmed = value.trim()
    // Note the value allowlist is enforced in BOTH modes. Leniency is about
    // recovering a user's theme, never about relaxing what may reach a CSS
    // custom property — isSafeCssColorValue is a security boundary (several
    // tokens land in `background` shorthand, where url() can fetch).
    if (!isSafeCssColorValue(trimmed)) {
      if (lenient) {
        colors[key] = DEFAULT_CUSTOM_APPEARANCE[key]
        continue
      }
      throw new Error(
        `Custom appearance key "${key}" must be a supported CSS color string.`,
      )
    }
    colors[key] = trimmed
  }

  return colors
}

export function coerceCustomAppearanceJson(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CUSTOM_APPEARANCE_JSON
  try {
    return stringifyCustomAppearance(parseCustomAppearanceJson(value))
  } catch {
    return DEFAULT_CUSTOM_APPEARANCE_JSON
  }
}

function isSafeCssColorValue(value: string): boolean {
  // WHY this is stricter than "anything style.setProperty accepts": several
  // app tokens are consumed by `background` shorthand declarations, not only
  // by `color`. A raw custom property value of `url(...)` is syntactically
  // valid CSS there and can trigger a network fetch even though the setting is
  // local-only. We still avoid a hex-only rule because modern themes need
  // oklch/color-mix/display-p3, but the accepted surface is deliberately
  // color-shaped: simple literals or known CSS color functions, with `var()`
  // and image/url functions rejected.
  if (value.length === 0 || value.length > 180) return false
  if (/[;{}]/.test(value)) return false
  if (/\b(?:url|image|image-set|cross-fade|element|paint|var)\s*\(/i.test(value)) {
    return false
  }
  if (!hasBalancedParentheses(value)) return false
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return true
  if (/^[a-z][a-z-]*$/i.test(value)) return true
  return /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i.test(value)
}

function hasBalancedParentheses(value: string): boolean {
  let depth = 0
  for (const char of value) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (depth < 0) return false
  }
  return depth === 0
}
