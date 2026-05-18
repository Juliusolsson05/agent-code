export const CUSTOM_APPEARANCE_COLOR_KEYS = [
  'canvas',
  'surface',
  'surfaceHi',
  'ink',
  'inkDim',
  'muted',
  'border',
  'borderHi',
  'accent',
  'accentFg',
  'accentSoft',
  'codeBg',
  'codeBorder',
  'danger',
  'codeInk',
  'codeInkDim',
  'userBg',
  'toolBg',
  'diffAddBg',
  'diffRemoveBg',
  'diffAddFg',
  'diffRemoveFg',
] as const

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
  codeBg: '--theme-code-bg',
  codeBorder: '--theme-code-border',
  danger: '--theme-danger',
  codeInk: '--theme-code-ink',
  codeInkDim: '--theme-code-ink-dim',
  userBg: '--theme-user-bg',
  toolBg: '--theme-tool-bg',
  diffAddBg: '--theme-diff-add-bg',
  diffRemoveBg: '--theme-diff-remove-bg',
  diffAddFg: '--theme-diff-add-fg',
  diffRemoveFg: '--theme-diff-remove-fg',
}

export const DEFAULT_CUSTOM_APPEARANCE: CustomAppearanceColors = {
  canvas: '#0a0a0a',
  surface: '#111113',
  surfaceHi: '#17171a',
  ink: '#e8e8e6',
  inkDim: '#a8a8a4',
  muted: '#5a5a56',
  border: '#1a1a1c',
  borderHi: '#272729',
  accent: '#7dd3a0',
  accentFg: '#0a0a0a',
  accentSoft: 'color-mix(in srgb, #7dd3a0 12%, transparent)',
  codeBg: '#050507',
  codeBorder: '#16161a',
  danger: '#ff6b6b',
  codeInk: '#e8e8e6',
  codeInkDim: '#a8a8a4',
  userBg: '#1f1f23',
  toolBg: '#151518',
  diffAddBg: '#0d2416',
  diffRemoveBg: '#2a1015',
  diffAddFg: '#4ade80',
  diffRemoveFg: '#f87171',
}

export const DEFAULT_CUSTOM_APPEARANCE_JSON = stringifyCustomAppearance(
  DEFAULT_CUSTOM_APPEARANCE,
)

export const CUSTOM_APPEARANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: CUSTOM_APPEARANCE_COLOR_KEYS,
  properties: Object.fromEntries(
    CUSTOM_APPEARANCE_COLOR_KEYS.map(key => [
      key,
      {
        type: 'string',
        minLength: 1,
        description:
          'CSS color value for the matching Agent Code theme token. Hex, named colors, and common color functions such as rgb(), hsl(), oklch(), color(), and color-mix() are accepted.',
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

export function parseCustomAppearanceJson(raw: string): CustomAppearanceColors {
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

  const record = parsed as Record<string, unknown>
  const allowed = new Set<string>(CUSTOM_APPEARANCE_COLOR_KEYS)
  const extra = Object.keys(record).filter(key => !allowed.has(key))
  if (extra.length > 0) {
    throw new Error(`Unknown custom appearance key: ${extra.join(', ')}`)
  }

  const colors = {} as CustomAppearanceColors
  for (const key of CUSTOM_APPEARANCE_COLOR_KEYS) {
    const value = record[key]
    if (typeof value !== 'string') {
      throw new Error(`Custom appearance key "${key}" must be a string.`)
    }
    const trimmed = value.trim()
    if (!isSafeCssColorValue(trimmed)) {
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
