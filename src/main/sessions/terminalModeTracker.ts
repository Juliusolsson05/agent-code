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
 *
 * Deliberately scans a CHUNK rather than parsing a stream: a sequence split
 * across two PTY writes is missed. That is acceptable because a TUI emits its
 * preamble in a single write, and because a missed mode leaves exactly today's
 * behaviour rather than a wrong one.
 */
const DEC_PRIVATE_MODE = /\x1b\[\?([0-9;]+)([hl])/g

export class TerminalModeTracker {
  private readonly active = new Set<TrackedMode>()

  /** Feed a raw PTY chunk. Cheap enough for the hot path. */
  observe(chunk: string): void {
    // Fast reject: the overwhelming majority of chunks carry no mode change.
    if (!chunk.includes('\x1b[?')) return
    for (const match of chunk.matchAll(DEC_PRIVATE_MODE)) {
      const set = match[2] === 'h'
      for (const raw of match[1].split(';')) {
        const mode = Number(raw) as TrackedMode
        if (!TRACKED_MODES.includes(mode)) continue
        if (set) this.active.add(mode)
        else this.active.delete(mode)
      }
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
