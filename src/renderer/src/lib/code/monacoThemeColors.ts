const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  transparent: '#00000000',
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(255, Math.max(0, Math.round(value)))
}

function toHexByte(value: number): string {
  return clampByte(value).toString(16).padStart(2, '0')
}

function normalizeAlpha(alpha: string | undefined): string {
  if (!alpha) return ''
  if (alpha.endsWith('%')) {
    return toHexByte((Number.parseFloat(alpha.slice(0, -1)) / 100) * 255)
  }
  return toHexByte(Number.parseFloat(alpha) * 255)
}

function normalizeHex(raw: string): string | null {
  const value = raw.trim().toLowerCase()
  const match = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)
  if (!match) return null
  const hex = match[1]
  if (hex.length === 3 || hex.length === 4) {
    return `#${hex.split('').map(char => `${char}${char}`).join('')}`
  }
  return `#${hex}`
}

function normalizeRgb(raw: string): string | null {
  const match = /^rgba?\(\s*([+-]?\d+(?:\.\d+)?%?)\s*[, ]\s*([+-]?\d+(?:\.\d+)?%?)\s*[, ]\s*([+-]?\d+(?:\.\d+)?%?)(?:\s*[,/]\s*([+-]?\d+(?:\.\d+)?%?))?\s*\)$/i.exec(raw.trim())
  if (!match) return null
  const channel = (part: string): number => {
    if (part.endsWith('%')) return (Number.parseFloat(part.slice(0, -1)) / 100) * 255
    return Number.parseFloat(part)
  }
  const alpha = normalizeAlpha(match[4])
  return `#${toHexByte(channel(match[1]))}${toHexByte(channel(match[2]))}${toHexByte(channel(match[3]))}${alpha}`
}

function normalizeWithBrowser(raw: string): string | null {
  if (typeof document === 'undefined') return null
  const option = document.createElement('option')
  option.style.color = ''
  option.style.color = raw
  if (!option.style.color) return null
  return normalizeRgb(option.style.color)
}

export function normalizeMonacoThemeColor(raw: string, fallback: string): string {
  const normalizedFallback = normalizeHex(fallback) ?? '#000000'
  const value = raw.trim()
  if (!value) return normalizedFallback

  const lower = value.toLowerCase()
  const normalized = normalizeHex(lower)
    ?? normalizeRgb(lower)
    ?? NAMED_COLORS[lower]
    ?? normalizeWithBrowser(value)

  // WHY Monaco gets a narrower color grammar than the rest of custom themes:
  // the DOM can consume broad CSS values, but Monaco's standalone theme code
  // copies editor foreground/background into token rules. Token color parsing
  // only accepts canonical 6/8 digit hex, so passing `#fff`, named colors, or
  // `rgb(...)` can crash rendering with "Illegal value for token color".
  // Normalizing here keeps custom appearance expressive while giving Monaco the
  // exact shape its stricter parser requires.
  return normalized ?? normalizedFallback
}

export function normalizeMonacoThemeColorAlpha(
  raw: string,
  alphaHex: string,
  fallback: string,
): string {
  const alpha = /^[0-9a-f]{2}$/i.test(alphaHex) ? alphaHex.toLowerCase() : 'ff'
  const normalized = normalizeMonacoThemeColor(raw, fallback)
  return `${normalized.slice(0, 7)}${alpha}`
}
