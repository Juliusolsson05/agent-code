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
// (cursor movement, erase, etc.). The param class includes private-mode
// and extension bytes (`?=><:`) so `\x1b[?25l` (cursor hide — spinners
// emit it constantly) and colon-form SGR (`38:5:196`, ITU T.416) are
// STRIPPED instead of surviving as literal garbage (PR524 review).
// Colon/private params never reach applySgr — strip-only. OSC sequences
// (window titles, hyperlinks) strip whole; `\x1b(B`-style charset
// designators (tput sgr0 emits them) strip too — the `(B` was visible.
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[([0-9;:?=><]*)([a-zA-Z])/g
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const CHARSET_RE = /\x1b[()][A-Za-z0-9]/g

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

type AnsiLinePart = { control: boolean; text: string }

/** Return the exclusive end of one ESC control string.
 *
 * WHY this scanner exists beside the narrower rendering regexes: CR is valid
 * payload data inside OSC (titles/hyperlinks) and can also occur in malformed
 * or vendor-extended CSI strings. Splitting on every raw `\r` before removing
 * controls tears those sequences in half; the remainder then leaks as visible
 * text or, worse, changes which SGR state reaches the final progress rewrite.
 * This boundary scanner need not interpret controls. It only keeps their bytes
 * atomic until parseAnsi/stripAnsi apply the existing subset policy. */
function ansiControlEnd(text: string, start: number): number {
  if (text.charCodeAt(start) !== 0x1b) return start + 1
  const introducer = text[start + 1]
  if (introducer === '[') {
    // ECMA-48 CSI ends at the first final byte 0x40–0x7e. Parameter and
    // intermediate bytes are deliberately opaque here so extensions remain
    // one token even when the SGR subset below does not understand them.
    for (let i = start + 2; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code >= 0x40 && code <= 0x7e) return i + 1
    }
    return text.length
  }
  if (introducer === ']') {
    // OSC terminates with BEL or ST (ESC backslash). An unterminated OSC owns
    // the tail: treating its embedded CR as display text would fabricate a
    // rewrite boundary inside a control string.
    for (let i = start + 2; i < text.length; i++) {
      if (text.charCodeAt(i) === 0x07) return i + 1
      if (text.charCodeAt(i) === 0x1b && text[i + 1] === '\\') return i + 2
    }
    return text.length
  }
  if (introducer === '(' || introducer === ')') return Math.min(start + 3, text.length)
  return Math.min(start + 2, text.length)
}

/** Collapse carriage-return rewrites per line while retaining ANSI control
 *  state. See module header and ansiControlEnd for WHY. */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text
  const output: string[] = []
  let line: AnsiLinePart[] = []
  const append = (control: boolean, value: string): void => {
    const tail = line[line.length - 1]
    if (tail?.control === control) tail.text += value
    else line.push({ control, text: value })
  }
  const flushLine = (newline: boolean): void => {
    output.push(line.map(part => part.text).join(''))
    if (newline) output.push('\n')
    line = []
  }

  for (let i = 0; i < text.length;) {
    if (text.charCodeAt(i) === 0x1b) {
      const end = ansiControlEnd(text, i)
      append(true, text.slice(i, end))
      i = end
      continue
    }
    if (text[i] === '\n') {
      flushLine(true)
      i += 1
      continue
    }
    if (text[i] === '\r') {
      if (text[i + 1] === '\n') {
        // CRLF is one line terminator. Consume both bytes here so the LF does
        // not become a second blank line.
        flushLine(true)
        i += 2
        continue
      }
      if (i === text.length - 1) {
        // A trailing CR announces a rewrite whose replacement has not arrived
        // in this growing payload. Keep the current visible line until it does.
        i += 1
        continue
      }
      // A terminal rewrite erases glyphs, not control-state transitions. Keep
      // every control token in its original relative position and remove only
      // visible text. Prefixing all controls would be subtly wrong: a color
      // change emitted after replacement text must remain after that text.
      line = line.filter(part => part.control)
      i += 1
      continue
    }
    append(false, text[i])
    i += 1
  }
  flushLine(false)
  return output.join('')
}

// DOM-span ceiling: adjacent-escape payloads (`x\x1b[m` repeated) can
// mint one span per character — ~50k spans under the byte cap froze the
// renderer in review testing. Past the ceiling, the tail renders as one
// unstyled span: content always survives, only styling degrades.
const MAX_SPANS = 4000

export function parseAnsi(
  text: string,
  initial: AnsiStyle = ANSI_INITIAL_STYLE,
): { spans: AnsiSpan[]; endStyle: AnsiStyle } {
  const cleaned = collapseCarriageReturns(text).replace(OSC_RE, '').replace(CHARSET_RE, '')
  const spans: AnsiSpan[] = []
  let style = initial
  let last = 0
  CSI_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CSI_RE.exec(cleaned)) !== null) {
    if (spans.length >= MAX_SPANS) {
      spans.push({ text: cleaned.slice(last).replace(CSI_RE, ''), style: ANSI_INITIAL_STYLE })
      return { spans, endStyle: style }
    }
    if (m.index > last) spans.push({ text: cleaned.slice(last, m.index), style })
    if (m[2] === 'm' && !/[?:=><]/.test(m[1])) {
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
  return (
    text.includes('\x1b[') ||
    text.includes('\x1b]') ||
    text.includes('\x1b(') ||
    text.includes('\x1b)') ||
    text.includes('\r')
  )
}

/** Strip all recognized escape sequences + collapse \r rewrites, returning
 *  plain text. Formatters use this so their regexes never fight SGR codes;
 *  bounded by callers (analyzeCommandOutput caps input). */
export function stripAnsi(text: string): string {
  return collapseCarriageReturns(text)
    .replace(CSI_RE, '')
    .replace(OSC_RE, '')
    .replace(CHARSET_RE, '')
}
