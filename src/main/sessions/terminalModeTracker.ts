/**
 * Tracks the DEC private modes a provider TUI has turned on, so an attaching
 * renderer can be put back into them.
 *
 * WHY this is needed at all - the bug it fixes:
 *
 * `attachAgentPty` hands a freshly-constructed xterm the trailing bytes of a
 * capped replay buffer, and `CappedTextBuffer` evicts the OLDEST bytes. A TUI
 * writes its mode preamble EXACTLY ONCE, at startup:
 *
 *     ESC [ ? 1049 h   alternate screen
 *     ESC [ ? 1000 h   mouse: button events
 *     ESC [ ? 1002 h   mouse: button + drag
 *     ESC [ ? 1003 h   mouse: any event, including the WHEEL
 *     ESC [ ? 1006 h   mouse reports in SGR encoding
 *
 * A TUI repainting at 60fps blows through the 512 KiB cap quickly, so on any
 * session with real activity that preamble has already been evicted. The new
 * terminal then never enters the alternate screen and never enables mouse
 * tracking, and nothing anywhere reconstructs the modes.
 *
 * The user-visible result for OpenCode, whose OpenTUI enables mouse capture by
 * default: the mouse WHEEL does nothing at all in a raw terminal pane. Not
 * because anything swallows it - nothing does - but because xterm only
 * attaches its wheel-to-mouse-report listener when the application has asked
 * for wheel events, and its fallback path returns early on a normal buffer.
 * Meanwhile the TUI paints absolutely-addressed full frames that never push a
 * line into scrollback, so native viewport scrolling has nothing to scroll
 * either. The pane still LOOKS correct, because a full-screen repaint renders
 * the same on either buffer, which is why this was hard to see.
 *
 * Claude Code and Codex are unaffected: they render inline and push real
 * scrollback, so their wheel scrolling needs no mode at all.
 *
 * WHY a hand-rolled scanner rather than a second terminal emulator: main
 * already runs a headless terminal for screen snapshots, but the replay buffer
 * is a BYTE stream and the question here is only "which of five one-shot modes
 * are currently on". A regex over each appended chunk answers exactly that in
 * microseconds, and cannot desynchronise the way an emulator fed a truncated
 * stream could.
 *
 * WHY only these modes: they are the ones whose loss is silent and
 * unrecoverable from a truncated stream. Colours, cursor shape and window
 * title are re-asserted by the TUI's next repaint. Screen buffer and mouse
 * tracking are not, because the application sets them once and never again.
 */

/** DEC private modes worth restoring, in the order a TUI sets them. */
const TRACKED_MODES = [1049, 1000, 1002, 1003, 1006] as const

type TrackedMode = (typeof TRACKED_MODES)[number]

/**
 * One or more semicolon-separated DEC private parameters followed by the
 * set/reset final byte, e.g. ESC [ ? 1000 ; 1002 ; 1006 h.
 */
const DEC_PRIVATE_MODE = /\x1b\[\?([0-9;]+)([hl])/g

/**
 * A sequence that has begun but not yet reached its final byte.
 *
 * Deliberately matches from the ESCAPE byte onward, not from the full
 * `ESC [ ?` marker: a chunk can end at ANY byte, including after just `ESC` or
 * `ESC [`. Requiring the whole marker before carrying anything meant a reset
 * split at either of those two points was still missed, which is the direction
 * that leaves a stale mode asserted at the next attach.
 */
const PARTIAL_SEQUENCE = /\x1b(?:\[(?:\?[0-9;]*)?)?$/
/** A sequence whose final byte has arrived. */
const COMPLETE_SEQUENCE = /^\x1b\[\?[0-9;]*[hl]/

/**
 * Longest partial sequence worth carrying to the next chunk.
 *
 * Comfortably past the realistic maximum — all five tracked modes in one
 * sequence is 28 characters — while bounding what a stream of digits could
 * otherwise accumulate. Anything longer is not a mode sequence being
 * assembled, so it is dropped rather than held.
 */
const MAX_PENDING = 64

export class TerminalModeTracker {
  private readonly active = new Set<TrackedMode>()
  /**
   * A sequence that began at the end of the previous chunk.
   *
   * WHY carrying this matters, and why "a split sequence is just missed" was
   * NOT an acceptable answer: the two directions are not symmetric. Missing a
   * turn-ON leaves today's behaviour, which is what the previous version
   * claimed. Missing a turn-OFF is strictly WORSE than today — the mode stays
   * in this set, and the next attach asserts a mode the application has
   * already left. A pane would be put back on the alternate screen after the
   * TUI suspended for an editor, or told to report mouse events to a program
   * that stopped listening. PTY chunks are split by pipe boundaries, not by
   * escape sequences, so this is ordinary rather than exotic.
   */
  private pending = ''

  /** Feed a raw PTY chunk. Cheap enough for the hot path. */
  observe(chunk: string): void {
    // Fast reject on the ESCAPE byte, not on the full marker, and only when
    // nothing is half-parsed: a chunk with no marker of its own can still be
    // the tail of a sequence begun earlier, and a chunk that ends mid-marker
    // has to be carried even though it contains no complete one.
    if (!this.pending && !chunk.includes('\x1b')) return
    const scan = this.pending + chunk
    this.pending = ''
    for (const match of scan.matchAll(DEC_PRIVATE_MODE)) {
      const set = match[2] === 'h'
      for (const raw of match[1].split(';')) {
        const mode = Number(raw) as TrackedMode
        if (!TRACKED_MODES.includes(mode)) continue
        if (set) this.active.add(mode)
        else this.active.delete(mode)
      }
    }
    // Carry only a genuinely unfinished sequence. `pending` can never hold a
    // COMPLETE one, so the match above cannot be applied twice.
    const partial = PARTIAL_SEQUENCE.exec(scan)
    if (partial && !COMPLETE_SEQUENCE.test(partial[0]) && partial[0].length <= MAX_PENDING) {
      this.pending = partial[0]
    }
  }

  /**
   * The preamble to write BEFORE a replay buffer, so a fresh terminal starts
   * in the modes the application believes it is already in.
   *
   * Emitted in TRACKED_MODES order rather than observation order: 1049 has to
   * come first, or everything the replay paints lands on the normal buffer and
   * is then abandoned when the switch happens. Re-setting a mode a terminal is
   * already in is a no-op, so this is safe to prepend unconditionally.
   */
  preamble(): string {
    return TRACKED_MODES
      .filter(mode => this.active.has(mode))
      .map(mode => `\x1b[?${mode}h`)
      .join('')
  }

  /** Test and diagnostic view. Never for control flow. */
  activeModes(): TrackedMode[] {
    return TRACKED_MODES.filter(mode => this.active.has(mode))
  }
}
