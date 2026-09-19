// The DEC private modes a terminal replay must restore before its bytes
// (#843).
//
// WHY this exists: SessionManager replays the last N KiB of a PTY to a
// terminal that attaches later (CappedTextBuffer). A full-screen TUI writes its
// mode preamble ONCE at startup. OpenCode 1.18.31, recorded in
// testing/fixtures/terminal-replay-modes/, writes:
//
//   ?1049h (alternate screen), ?2004h, ?1000h ?1002h ?1003h (mouse), ?1006h
//
// It then repaints whole frames at up to 60 fps, so the 512 KiB cap evicts
// that preamble within minutes. A freshly constructed xterm then sits on the
// NORMAL buffer with no mouse tracking while the application believes the
// opposite, and the mouse wheel reaches nobody. The pane still looks right,
// because a full-frame repaint renders the same on either buffer.
//
// WHY the state AT THE REPLAY START, fed from the EVICTED bytes: a first fix
// tracked modes as chunks passed and prepended the CURRENT modes. It was
// reverted after review (docs/superpowers/research/
// 2026-09-08-post-merge-regression-audit.md). If the retained bytes still
// contain output on the normal buffer followed by a later ?1049h, prefixing
// the current ?1049h moves that earlier output onto the alternate buffer, and
// the replay's own ?1049l then throws it away. The only correct prefix is
// what the evicted prefix left behind; the retained bytes then evolve it
// exactly as they did live.
//
// WHY a state machine and not a set of flags (the same review): mouse
// protocols are mutually exclusive in xterm. ?1000h ?1003h leaves ANY;
// ?1003h then ?1000h leaves VT200; and resetting ANY protocol code turns
// tracking off (xterm.js InputHandler.resetModePrivate). Encodings behave the
// same way. `ESC c` (RIS) resets everything. 47, 1047 and 1049 all select the
// alternate buffer.
//
// Deliberately NOT tracked:
// - ?2026 (synchronized output) is per-frame. A prefix could leave the
//   terminal holding every paint until a matching ?2026l that the replay
//   may not contain.
// - Queries (DECRQM `$p`, DA, `?u`). They ask the terminal to ANSWER, and
//   replaying them would send stale answers back to the program.

type MouseProtocol = 9 | 1000 | 1002 | 1003
type MouseEncoding = 1006 | 1016

const MOUSE_PROTOCOLS: ReadonlySet<number> = new Set([9, 1000, 1002, 1003])
// Only the encodings xterm.js implements: 1005 (UTF-8) and 1015 (urxvt) are
// logged and ignored there (#2507), so tracking them would only prefix a
// sequence that changes nothing, or wrongly replace a real SGR state.
const MOUSE_ENCODINGS: ReadonlySet<number> = new Set([1006, 1016])
const ALTERNATE_SCREEN: ReadonlySet<number> = new Set([47, 1047, 1049])
/** Simple on/off modes with xterm's defaults: application cursor keys (1),
 *  cursor visible (25), focus reporting (1004) and bracketed paste (2004). */
const FLAG_DEFAULTS: ReadonlyMap<number, boolean> = new Map([[1, false], [25, true], [1004, false], [2004, false]])

/** An unterminated sequence longer than this is not a mode sequence and is
 *  dropped rather than carried forever. */
const MAX_CARRY = 64

export class DecModeTracker {
  private alternate = false
  private protocol: MouseProtocol | null = null
  private encoding: MouseEncoding | null = null
  private readonly flags = new Map(FLAG_DEFAULTS)
  // An escape sequence cut by a chunk boundary. Evicted pieces arrive in
  // stream order, so the next feed completes it.
  private carry = ''

  feed(text: string): void {
    const input = this.carry + text
    this.carry = ''
    let index = input.indexOf('\x1b')
    while (index !== -1) {
      const next = input[index + 1]
      if (next === undefined) {
        this.carry = flatCopy(input.slice(index))
        return
      }
      if (next === 'c') {
        this.reset()
        index = input.indexOf('\x1b', index + 2)
        continue
      }
      if (next === '[' && input[index + 2] === '?') {
        let end = index + 3
        while (end < input.length && /[0-9;]/.test(input[end]!)) end += 1
        if (end >= input.length) {
          if (input.length - index <= MAX_CARRY) this.carry = flatCopy(input.slice(index))
          return
        }
        const final = input[end]
        if (final === 'h' || final === 'l') {
          for (const param of input.slice(index + 3, end).split(';')) {
            if (param !== '') this.apply(Number(param), final === 'h')
          }
        }
        index = input.indexOf('\x1b', end + 1)
        continue
      }
      if (next === '[' && input[index + 2] === undefined) {
        this.carry = flatCopy(input.slice(index))
        return
      }
      index = input.indexOf('\x1b', index + 1)
    }
  }

  /** The sequences that put a fresh xterm into the tracked state. Empty when
   *  the state is xterm's default, so a session that never set a mode replays
   *  byte-for-byte as before. */
  prefix(): string {
    let out = ''
    if (this.alternate) out += '\x1b[?1049h'
    if (this.protocol !== null) out += `\x1b[?${this.protocol}h`
    if (this.encoding !== null) out += `\x1b[?${this.encoding}h`
    for (const [mode, value] of this.flags) {
      if (value !== FLAG_DEFAULTS.get(mode)) out += `\x1b[?${mode}${value ? 'h' : 'l'}`
    }
    return out
  }

  private apply(mode: number, set: boolean): void {
    if (ALTERNATE_SCREEN.has(mode)) {
      this.alternate = set
    } else if (MOUSE_PROTOCOLS.has(mode)) {
      // Resetting ANY protocol code disables tracking, as xterm.js does.
      this.protocol = set ? mode as MouseProtocol : null
    } else if (MOUSE_ENCODINGS.has(mode)) {
      // Resetting EITHER encoding returns to the default one, whichever is
      // active (xterm.js resetModePrivate: `case 1006: case 1016:`).
      this.encoding = set ? mode as MouseEncoding : null
    } else if (FLAG_DEFAULTS.has(mode)) {
      this.flags.set(mode, set)
    }
  }

  private reset(): void {
    this.alternate = false
    this.protocol = null
    this.encoding = null
    for (const [mode, value] of FLAG_DEFAULTS) this.flags.set(mode, value)
  }
}

// The carry is at most a few dozen characters, but a V8 slice of an evicted
// multi-megabyte chunk would keep that whole chunk alive (#321, and the same
// idiom as cappedTextBuffer.ts). Force a flat copy.
function flatCopy(text: string): string {
  return Buffer.from(text, 'utf16le').toString('utf16le')
}
