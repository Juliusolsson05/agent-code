// Comparison-only normalization. Never rewrite arbitrary durations, counts or
// /rc strings: those can be real composer edits, command arguments or output.
// Global replacements made "wait 5s" and "wait 6s" equivalent (#53). Unknown
// chrome costs a full frame; it must never broaden the fast path to content.
const CLAUDE_STATUS = /^(\s*)[·✢✳✶✻✽✺] ([A-Za-z][A-Za-z' -]*…) \(((?:\d+h\s*)?(?:\d+m\s*)?\d+s)((?: · [↑↓] \d+(?:\.\d+)?k? tokens)?(?: · thinking…)?)\)[ \t]*$/
const CODEX_STATUS = /^(\s*)[•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working \((?:\d+h\s*)?(?:\d+m\s*)?\d+s • esc to interrupt\)[ \t]*$/
const TOKEN_COUNTER = /\b\d+(?:\.\d+)?k?\s+tokens\b/g
const RC_FOOTER = /^ {2}⏵⏵ bypass permissions on \(shift\+tab to cycle\).*\/rc(?: connecting…)?[ \t]*$/

export function normalizeVolatileScreenText(text: string): string {
  let insideComposer = false
  return text.split('\n').map(line => {
    // Claude's multiline composer is bounded by horizontal rules. Even a
    // pasted exact status signature inside that region is user content. Other
    // divider layouts may conservatively disable caching, which is harmless.
    if (/^\s*─{3,}\s*$/.test(line)) {
      insideComposer = !insideComposer
      return line
    }
    if (insideComposer) return line
    const claude = CLAUDE_STATUS.exec(line)
    if (claude) return claude[1] + '⋯ ' + claude[2] + ' (Ns' + claude[4]!.replace(TOKEN_COUNTER, 'N tokens') + ')'
    const codex = CODEX_STATUS.exec(line)
    if (codex) return codex[1] + '⋯ Working (Ns • esc to interrupt)'
    if (RC_FOOTER.test(line)) return line.replace(/\/rc connecting…/, '/rc').trimEnd()
    // Do not trim drafts or normalize arbitrary bullet-prefixed output.
    return line
  }).join('\n')
}

export type GatedScreenFrame = {
  plain: string
  recent: string
  /** Slash-picker state parsed from the terminal GRID, not from `plain`:
   *  arrow navigation changes only cell colours, so it is invisible to the
   *  text comparison and must be part of the key (review of #761). */
  picker?: unknown
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
  private readonly last = new Map<string, { plain: string; recent: string; picker: string; droppedSince: number }>()
  private readonly stats: ScreenFrameGateStats = { emitted: 0, dropped: 0 }

  shouldEmit(sessionId: string, frame: GatedScreenFrame): boolean {
    const plain = normalizeVolatileScreenText(frame.plain)
    // WHY `recent` is only normalized when it is a different string: for
    // an alt-screen TUI (Claude) it is byte-identical to `plain` in every
    // frame, so the second normalization would be pure waste on the hot
    // path; Codex has real scrollback and pays for it.
    const recent = frame.recent === frame.plain ? plain : normalizeVolatileScreenText(frame.recent)
    // WHY the picker is keyed by its JSON: it is a small object (visible flag
    // plus a handful of items) and it is the only part of a frame that can
    // change without a single character of `plain` changing — the parser
    // reads selection from cell colours. Before the gate, a picker change
    // rode along on the next chrome tick; now the chrome tick is dropped,
    // so the picker must count as a change in its own right.
    const picker = frame.picker === undefined ? '' : JSON.stringify(frame.picker)
    const previous = this.last.get(sessionId)
    if (previous && previous.plain === plain && previous.recent === recent && previous.picker === picker) {
      previous.droppedSince += 1
      this.stats.dropped += 1
      return false
    }
    this.last.set(sessionId, { plain, recent, picker, droppedSince: 0 })
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
