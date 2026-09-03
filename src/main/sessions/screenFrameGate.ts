// Screen-frame gate: drop repaints that differ only in volatile TUI chrome.
//
// WHY this exists (#746): `session:screen` is the highest-volume IPC channel
// and almost all of it is redundant. One Claude session recorded 4,728
// frames in 13 minutes (6 Hz, 8.3 KB each) and 99% of consecutive frames
// differed only in the spinner line — the glyph rotating through ·✢✳✶✻✽,
// the elapsed timer ticking, the token counter — or in the `/rc connecting…`
// blink of the status line. Every one of those frames was cloned through the
// coalescer, sent to the renderer (a new runtime object, a workspace
// re-render), forwarded to the remote client and JSON-stringified by the
// session recorder. The headless terminal already gates on EXACT equality
// of the plain text, which by construction never fires while a spinner
// animates.
//
// WHY normalize-and-compare rather than a time throttle: a throttle still
// emits N frames per second of pure spinner for as long as an agent thinks;
// this emits zero, and still passes a composer keystroke or a new output
// line within the same 100 ms tick, because anything outside the volatile
// shapes changes the normalized text.
//
// WHY the emitted frame is the RAW one: normalization is only the
// comparison key. Consumers keep seeing the real spinner glyph and timer on
// every frame that carries a real change, so the debug panel and remote
// client are never shown a rewritten screen.
//
// WHY the gate sits at the manager's re-emit and not in the providers or
// the headless package: the manager is the one point feeding the forwarder
// (renderer IPC), the remote server and the recorder, and everything that
// must see every raw frame — condition parsers, composer-ready detection,
// the prompt gate — runs in the headless package or the provider session,
// i.e. BEFORE the manager. `lastScreenSnapshot` (MCP/debug readers) is
// still updated from the raw frame by the caller.
//
// WHY these shapes and no more: each rule is backed by a recorded
// consecutive-frame diff (session-recordings, 2026-09-03). Adding a rule
// for text that is not demonstrably volatile would hide real changes; the
// cost of a missing rule is one extra emitted frame, which is the status
// quo.

const CLAUDE_SPINNER_GLYPHS = '·✢✳✶✻✽'
const CODEX_BRAILLE_GLYPHS = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const SPINNER_LINE_START = new RegExp(`^(\\s*)[${CLAUDE_SPINNER_GLYPHS}${CODEX_BRAILLE_GLYPHS}](?=\\s|$)`)
// `5s`, `12s`, `1m 9s`, `2h 3m 4s` — the elapsed counters every TUI spinner
// carries. Word-bounded so `k8s`, `s3`, hex and version strings survive.
const ELAPSED_TIMER = /\b(?:\d+h\s*)?(?:\d+m\s*)?\d+s\b/g
// `↓ 1.2k tokens`, `↑ 340 tokens`, `(2.3k tokens)`.
const TOKEN_COUNTER = /\b\d+(?:\.\d+)?k?\s+tokens\b/g
// The remote-control status blinks "connecting…" on and off every frame.
const RC_CONNECTING = /\/rc connecting…/g
const TRAILING_WHITESPACE = /[ \t]+$/gm

export function normalizeVolatileScreenText(text: string): string {
  if (text.length === 0) return text
  return text
    .split('\n')
    .map(line => line.replace(SPINNER_LINE_START, '$1⋯'))
    .join('\n')
    .replace(ELAPSED_TIMER, 'Ns')
    .replace(TOKEN_COUNTER, 'N tokens')
    .replace(RC_CONNECTING, '/rc')
    .replace(TRAILING_WHITESPACE, '')
}

export type GatedScreenFrame = {
  plain: string
  recent: string
}

export type ScreenFrameGateStats = {
  emitted: number
  dropped: number
}

/**
 * Per-session memory of the last EMITTED frame's normalized text. The
 * first frame of a session always passes; later frames pass when their
 * normalized `plain` or `recent` differs from the last emitted one.
 */
export class ScreenFrameGate {
  private readonly last = new Map<string, { plain: string; recent: string; droppedSince: number }>()
  private readonly stats: ScreenFrameGateStats = { emitted: 0, dropped: 0 }

  shouldEmit(sessionId: string, frame: GatedScreenFrame): boolean {
    const plain = normalizeVolatileScreenText(frame.plain)
    // WHY `recent` is only normalized when it is a different string: for
    // an alt-screen TUI (Claude) it is byte-identical to `plain` in every
    // frame, so the second normalization would be pure waste on the hot
    // path; Codex has real scrollback and pays for it.
    const recent = frame.recent === frame.plain ? plain : normalizeVolatileScreenText(frame.recent)
    const previous = this.last.get(sessionId)
    if (previous && previous.plain === plain && previous.recent === recent) {
      previous.droppedSince += 1
      this.stats.dropped += 1
      return false
    }
    this.last.set(sessionId, { plain, recent, droppedSince: 0 })
    this.stats.emitted += 1
    return true
  }

  /** How many frames were dropped between the two most recent emits for
   *  the session — the number the perf journal records per emitted frame,
   *  so the gate's effect is visible without a per-drop record. Read it
   *  BEFORE the next `shouldEmit` overwrites the entry. */
  droppedBeforeLastEmit(sessionId: string): number {
    return this.last.get(sessionId)?.droppedSince ?? 0
  }

  forget(sessionId: string): void {
    this.last.delete(sessionId)
  }

  /** Cumulative counts for the perf journal / tests. */
  snapshotStats(): ScreenFrameGateStats {
    return { ...this.stats }
  }
}
