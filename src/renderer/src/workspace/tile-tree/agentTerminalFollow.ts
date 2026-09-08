import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import type { IMarker, Terminal } from '@xterm/xterm'

// AgentTerminalLeaf keeps its expensive PTY/xterm attachment keyed on sessionId.
// Follow intent changes independently of that lifetime: consuming it in this
// hook avoids remounting the terminal and losing scrollback on every toggle.
// The hook runs before the leaf's mount effect, so a fresh terminal has no
// pre-tail position to restore. The leaf pins once its attach replay is parsed.
type FollowArgs = {
  sessionId: string
  scrollToLatestRequest: number
  tailActive: boolean
  termRef: RefObject<Terminal | null>
  /**
   * Bytes that make THIS provider's TUI scroll its own transcript to the
   * latest message, or null when the xterm viewport is the thing that scrolls.
   * See ProviderFeatureCapabilities.terminalJumpToLatestKey.
   */
  jumpKey: string | null
}

function isAtBottom(term: Terminal): boolean {
  return term.buffer.active.viewportY >= term.buffer.active.baseY
}

export function useAgentTerminalFollow({
  sessionId, scrollToLatestRequest, tailActive, termRef, jumpKey,
}: FollowArgs) {
  // Read at request time rather than closed over, so a provider switch that
  // keeps the same pane cannot send the previous provider's chord.
  const jumpKeyRef = useRef(jumpKey)
  jumpKeyRef.current = jumpKey
  // The mount-owned PTY subscriber reads the latest verdict at callback time,
  // not when a chunk was queued: parsing can finish after Tail was disabled.
  const tailActiveRef = useRef(tailActive)
  tailActiveRef.current = tailActive
  const tailEngagedRef = useRef(false)
  const savedLineRef = useRef<IMarker | null>(null)
  const jumpBaselineRef = useRef<number | null>(null)

  useEffect(() => {
    // Related-agent tabs can change sessionId without remounting the React
    // leaf. None of A's saved position or jump counter belongs to session B.
    tailEngagedRef.current = false
    savedLineRef.current?.dispose()
    savedLineRef.current = null
    jumpBaselineRef.current = null
    return () => {
      savedLineRef.current?.dispose()
      savedLineRef.current = null
    }
  }, [sessionId])

  useEffect(() => {
    // The counter also survives rendered/raw surface swaps. Baseline rather
    // than replay the old request; a newly attached xterm starts at its tail.
    // New requests come from scrollFocusedToLatest and softReloadRuntime.
    if (jumpBaselineRef.current === null) {
      jumpBaselineRef.current = scrollToLatestRequest
      return
    }
    if (scrollToLatestRequest === jumpBaselineRef.current) return
    jumpBaselineRef.current = scrollToLatestRequest
    const key = jumpKeyRef.current
    if (key) {
      // WHY this writes to the PTY instead of moving the viewport:
      //
      // A provider whose TUI runs on the ALTERNATE SCREEN owns its transcript
      // internally and never evicts a line into xterm scrollback, so
      // `viewportY === baseY` always holds and `scrollToBottom()` is a
      // guaranteed no-op. That is why Jump to Latest silently did nothing on
      // OpenCode Terminal panes while working on Claude and Codex raw views,
      // which render inline on the normal buffer. The only thing that can move
      // that transcript is the TUI's own key.
      //
      // Fire-and-forget, and deliberately not awaited or reported: this runs
      // inside a passive effect driven by a counter, the write is one keypress
      // the user could have typed themselves, and a rejected send means the
      // pane is gone — in which case there is nothing to scroll and nothing to
      // say about it.
      void window.api.sendInput(sessionId, key)
      return
    }
    termRef.current?.scrollToBottom()
  }, [scrollToLatestRequest, sessionId, termRef])

  useEffect(() => {
    const term = termRef.current
    if (tailActive && !tailEngagedRef.current) {
      tailEngagedRef.current = true
      if (term) {
        const buffer = term.buffer.active
        // Numeric viewport offsets are not content anchors. Once scrollback
        // fills, both baseY and length stay constant while old lines are
        // evicted. xterm markers follow trims/deletions and dispose themselves
        // when their line is lost. Register relative to the cursor, not baseY,
        // so the anchor names exactly the first line the user was reading.
        if (buffer.type === 'normal' && !isAtBottom(term)) {
          savedLineRef.current = term.registerMarker(buffer.viewportY - buffer.baseY - buffer.cursorY)
        }
        term.scrollToBottom()
      }
      return
    }
    if (!tailActive && tailEngagedRef.current) {
      tailEngagedRef.current = false
      const saved = savedLineRef.current
      savedLineRef.current = null
      if (term && saved && term.buffer.active.type === 'normal') {
        // An evicted anchor cannot be restored; show the oldest surviving
        // content instead. Never apply a normal-buffer anchor to an alternate
        // screen. scrollToLine is the public viewport writer, not viewportY.
        term.scrollToLine(saved.isDisposed ? 0 : saved.line)
      }
      saved?.dispose()
    }
  }, [sessionId, tailActive, termRef])

  return useMemo(() => ({
    tailActiveRef,
    attach: (term: Terminal) => {
      let disposed = false
      let queued = false
      const subscription = term.onScroll(() => {
        // onScroll also fires while parsing output, not just user scrolls.
        // Coalesce dispatches; xterm's viewport rejects a synchronous re-pin
        // inside its own scroll handler. A microtask exits that reentrancy
        // fence. The write-completion pin in the leaf still handles the final
        // post-parse bottom, after xterm has updated its scroll dimensions.
        if (queued || !tailActiveRef.current || isAtBottom(term)) return
        queued = true
        queueMicrotask(() => {
          queued = false
          if (disposed || termRef.current !== term || !tailActiveRef.current || isAtBottom(term)) return
          term.scrollToBottom()
        })
      })
      return () => {
        disposed = true
        subscription.dispose()
        savedLineRef.current?.dispose()
        savedLineRef.current = null
      }
    },
  }), [termRef])
}
