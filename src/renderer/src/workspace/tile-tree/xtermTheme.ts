import type { ITheme } from '@xterm/xterm'

function readThemeToken(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback
}

// Turn a theme token into the flat `#rrggbbaa` xterm needs.
//
// WHY rgb()/rgba() is accepted and flattened over `over`: Nord — the default
// theme — expresses its muted ink as an alpha over the canvas
// (`rgba(216, 222, 233, 0.42)`). Before this, any non-hex token fell back to
// a literal from the old dark palette, so the terminal's inactive selection
// and scrollbar thumb were the one surface where the green-era colours
// survived a theme change. The token's own alpha is composited against
// `over` (the canvas) first, then the caller's per-surface `alpha` is
// appended; without `over` a translucent token cannot be flattened and the
// fallback is returned instead of guessing.
export function colorWithAlpha(color: string, alpha: string, fallback: string, over?: string): string {
  const normalized = color.trim()
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return `${normalized}${alpha}`
  if (/^#[0-9a-f]{8}$/i.test(normalized)) return `${normalized.slice(0, 7)}${alpha}`
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(normalized)
  if (!rgb) return fallback
  const source = rgb.slice(1, 4).map(part => Math.min(255, Number.parseInt(part, 10)))
  const sourceAlpha = rgb[4] === undefined ? 1 : Math.min(1, Math.max(0, Number.parseFloat(rgb[4])))
  const base = over === undefined ? null : /^#([0-9a-f]{6})$/i.exec(over.trim())
  if (sourceAlpha < 1 && !base) return fallback
  const channels = source.map((value, index) => {
    const under = base ? Number.parseInt(base[1].slice(index * 2, index * 2 + 2), 16) : 0
    return Math.round(sourceAlpha * value + (1 - sourceAlpha) * under)
  })
  return `#${channels.map(value => value.toString(16).padStart(2, '0')).join('')}${alpha}`
}

function relativeLuminance(hex: string): number | null {
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

export function readXtermTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement)
  const background = readThemeToken(styles, '--theme-canvas', '#171b21')
  const foreground = readThemeToken(styles, '--theme-ink', '#d8dee9')
  const muted = readThemeToken(styles, '--theme-muted', '#686d75')
  const border = readThemeToken(styles, '--theme-border-hi', '#3b4252')
  const accent = readThemeToken(styles, '--theme-accent', '#88c0d0')
  const accentFg = readThemeToken(styles, '--theme-accent-fg', '#171b21')
  const lightBackground = (relativeLuminance(background) ?? 0) > 0.5
  const ansi = lightBackground
    ? {
        black: '#4a4a48',
        red: '#9f2929',
        green: '#247a46',
        yellow: '#7a4d00',
        blue: '#1f5eaa',
        magenta: '#8b247f',
        cyan: '#0f766e',
        white: foreground,
        brightBlack: '#6f6b62',
        brightRed: '#7f1d1d',
        brightGreen: '#166534',
        brightYellow: '#704600',
        brightBlue: '#174f96',
        brightMagenta: '#6b21a8',
        brightCyan: '#155e75',
        brightWhite: foreground,
      }
    : {
        black: '#2f3437',
        red: '#d04242',
        green: '#268a4a',
        yellow: '#9a6500',
        blue: '#2c6bb5',
        magenta: '#8a4db8',
        cyan: '#0f766e',
        white: '#d6d3ca',
        brightBlack: '#6b6f72',
        brightRed: '#ff6b6b',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff',
      }

  return {
    foreground,
    background,
    cursor: accent,
    cursorAccent: accentFg,
    selectionBackground: colorWithAlpha(accent, '44', '#88c0d044', background),
    selectionInactiveBackground: colorWithAlpha(muted, '33', '#686d7533', background),
    scrollbarSliderBackground: colorWithAlpha(muted, '55', '#686d7555', background),
    scrollbarSliderHoverBackground: colorWithAlpha(muted, '88', '#686d7588', background),
    scrollbarSliderActiveBackground: colorWithAlpha(accent, 'aa', '#88c0d0aa', background),
    overviewRulerBorder: border,

    // WHY the ANSI table is intentionally not generated from the UI palette:
    // terminal programs encode meaning into the standard 16 colors, and many
    // CLIs assume these colors are reasonably close to a familiar terminal
    // scheme. Deriving red/green/yellow/blue from Agent Code's single accent
    // token would make tools like git, test runners, and curses apps look
    // fashionable but less predictable. The app theme owns the terminal's
    // canvas, ink, cursor, selection, and scrollbar; ANSI remains a stable
    // terminal palette with contrast against both light and dark canvases.
    // On a light canvas, ANSI "bright" colors must become darker, not lighter:
    // traditional terminal brights are tuned for black backgrounds and vanish
    // on cream. We keep the semantic hue table stable, but branch the actual
    // values by background luminance so common CLI output remains readable.
    ...ansi,
  }
}

export function syncXtermTheme(term: { options: { theme?: ITheme } }): void {
  term.options.theme = readXtermTheme()
}
