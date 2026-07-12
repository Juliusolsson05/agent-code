// ANSI SGR subset parser for tool/command output.
//
// WHY this exists: the feed used to render command output verbatim into
// <pre>, so colored test runners / build tools showed literal `\x1b[0m`
// garbage — the single most-visible rendering gap in Bash-heavy
// sessions. This module turns SGR-styled text into styled span
// descriptors that AnsiText.tsx paints.
//
// WHY a subset and not a terminal emulator: transcripts carry the raw
// bytes a NON-interactive command wrote to a pipe. We honor SGR color/
// weight codes and normalize carriage-return progress rewrites; cursor
// movement / clear-line sequences are stripped (they are meaningless
// outside a real terminal grid — the raw PTY view exists for that).
//
// WHY \r collapses to "keep the last segment": progress bars emit
// `50%\r75%\r100%`; rendering all three rewrites triples the output and
// reads as garbage. Keeping the final rewrite per line is what the
// user's terminal would have shown at rest.
//
// WHY the parser is pure and React-free: OutputWell re-parses on each
// growing live payload; keeping this allocation-light and testable in
// isolation matters. It also lets the remote phone client share it —
// nothing in here may touch Node/Electron APIs.

export type AnsiStyle = {
  /** 0-15 = terminal palette index (resolved against the xterm theme
   *  at paint time so light/dark both work); '#rrggbb' for 256/24-bit
   *  colors; null = default ink. */
  fg: number | string | null
  bg: number | string | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
}

export type AnsiSpan = { text: string; style: AnsiStyle }

export const ANSI_INITIAL_STYLE: AnsiStyle = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
}

// CSI sequences: keep SGR (final byte `m`), strip everything else
// (cursor movement, erase, etc.). OSC sequences (`\x1b]…\x07` or
// `\x1b]…\x1b\\`) — window titles and hyperlinks — are stripped whole.
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[([0-9;]*)([a-zA-Z])/g
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** xterm 256-color index → palette index (0-15) or '#rrggbb'.
 *  16-231 is the 6×6×6 color cube; 232-255 the grayscale ramp. */
function xterm256(n: number): number | string {
  if (n < 16) return n
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    const h = v.toString(16).padStart(2, '0')
    return `#${h}${h}${h}`
  }
  const idx = n - 16
  const steps = [0, 95, 135, 175, 215, 255]
  const r = steps[Math.floor(idx / 36)]
  const g = steps[Math.floor((idx % 36) / 6)]
  const b = steps[idx % 6]
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

function applySgr(style: AnsiStyle, params: number[]): AnsiStyle {
  const s = { ...style }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) {
      // Full reset replaces the whole style — but keep scanning: a
      // sequence like `0;31` resets THEN sets red.
      s.fg = null; s.bg = null; s.bold = false; s.dim = false
      s.italic = false; s.underline = false; s.inverse = false
    } else if (p === 1) s.bold = true
    else if (p === 2) s.dim = true
    else if (p === 3) s.italic = true
    else if (p === 4) s.underline = true
    else if (p === 7) s.inverse = true
    else if (p === 22) { s.bold = false; s.dim = false }
    else if (p === 23) s.italic = false
    else if (p === 24) s.underline = false
    else if (p === 27) s.inverse = false
    else if (p >= 30 && p <= 37) s.fg = p - 30
    else if (p === 39) s.fg = null
    else if (p >= 40 && p <= 47) s.bg = p - 40
    else if (p === 49) s.bg = null
    else if (p >= 90 && p <= 97) s.fg = p - 90 + 8
    else if (p >= 100 && p <= 107) s.bg = p - 100 + 8
    else if (p === 38 || p === 48) {
      // Extended color: `38;5;<n>` (256-color) or `38;2;<r>;<g>;<b>`.
      const target: 'fg' | 'bg' = p === 38 ? 'fg' : 'bg'
      if (params[i + 1] === 5 && params[i + 2] !== undefined) {
        s[target] = xterm256(params[i + 2])
        i += 2
      } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
        s[target] = `#${[params[i + 2], params[i + 3], params[i + 4]]
          .map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0'))
          .join('')}`
        i += 4
      }
      // Malformed extended sequence: ignore (stop consuming params).
    }
    // Unknown SGR codes: ignored, style unchanged.
  }
  return s
}

/** Collapse carriage-return rewrites per line: keep only the final
 *  segment after the last `\r`. See module header for WHY. */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .split('\n')
    .map(line => {
      // CRLF line endings: the \r is a line TERMINATOR, not a rewrite —
      // strip it instead of collapsing, or every CRLF line (curl
      // headers, Windows-origin output) collapses to the empty string
      // after it (PR524 review, HIGH-1). Likewise a line that ENDS in
      // \r mid-stream is a rewrite that hasn't arrived yet — keep the
      // text before it visible, as a real terminal would.
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
      const at = trimmed.lastIndexOf('\r')
      return at === -1 ? trimmed : trimmed.slice(at + 1)
    })
    .join('\n')
}

export function parseAnsi(
  text: string,
  initial: AnsiStyle = ANSI_INITIAL_STYLE,
): { spans: AnsiSpan[]; endStyle: AnsiStyle } {
  const cleaned = collapseCarriageReturns(text).replace(OSC_RE, '')
  const spans: AnsiSpan[] = []
  let style = initial
  let last = 0
  CSI_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CSI_RE.exec(cleaned)) !== null) {
    if (m.index > last) spans.push({ text: cleaned.slice(last, m.index), style })
    if (m[2] === 'm') {
      const params = m[1] === '' ? [0] : m[1].split(';').map(n => Number(n) || 0)
      style = applySgr(style, params)
    }
    // Non-SGR CSI: stripped — no span emitted for the sequence itself.
    last = CSI_RE.lastIndex
  }
  if (last < cleaned.length) spans.push({ text: cleaned.slice(last), style })
  return { spans, endStyle: style }
}

/** Fast probe: does this text contain any escape sequence at all?
 *  OutputWell uses it to skip span-building for the overwhelmingly
 *  common plain-output case. */
export function hasAnsi(text: string): boolean {
  return text.includes('\x1b[') || text.includes('\x1b]') || text.includes('\r')
}
