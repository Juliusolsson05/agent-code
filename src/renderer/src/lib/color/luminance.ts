// WHY this lives in lib/color instead of staying private to xtermTheme:
// two unrelated consumers now need the same question answered — xterm picks
// its ANSI ramp from background luminance, and saved themes decide their
// light/dark family the same way. Duplicating the sRGB transfer function
// would be the kind of quiet divergence that makes a light custom theme
// render dark ANSI colors months later with no obvious cause.
//
// Returns null for anything that is not a 6-digit hex. Callers must decide
// what an unknown color means; this function refuses to guess. Note that
// custom appearance values are validated against a much wider grammar
// (rgb(), oklch(), color-mix(), bare identifiers...), so null is a normal
// result here, not an error condition.
export function relativeLuminance(hex: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const [r, g, b] = [0, 2, 4].map(offset => {
    const channel = Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
