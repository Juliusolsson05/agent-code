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
          'CSS color value for the matching Agent Code theme token. Hex, rgb(), hsl(), oklch(), color-mix(), and named colors are accepted as raw CSS strings.',
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
        `Custom appearance key "${key}" must be a non-empty CSS color string without semicolons or braces.`,
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
  // WHY this validation is intentionally schema-level rather than a full CSS
  // parser: the user asked for raw JSON with freely-defined application
  // colors. Browser support for modern color syntax moves faster than a
  // hand-written validator (`oklch()`, `color-mix()`, display-p3, etc.), so a
  // strict "hex only" check would make the custom mode feel fake immediately.
  // The real safety boundary is narrower: these values are only ever assigned
  // to CSS custom properties via `style.setProperty`, so reject characters
  // that can try to terminate or open declarations and otherwise let CSS own
  // color syntax validity.
  return value.length > 0 && value.length <= 180 && !/[;{}]/.test(value)
}
