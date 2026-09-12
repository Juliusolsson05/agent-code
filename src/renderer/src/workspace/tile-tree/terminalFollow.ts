import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import type { IMarker, Terminal } from '@xterm/xterm'

// Both xterm leaves (AgentTerminalLeaf, and TerminalLeaf since #865) keep their
// expensive PTY/xterm attachment keyed on sessionId. Follow intent changes
// independently of that lifetime: consuming it in this hook avoids remounting
// the terminal and losing scrollback on every toggle. The hook runs before the
// leaf's mount effect, so a fresh terminal has no pre-tail position to
// restore. The leaf pins once its attach replay is parsed.
type FollowArgs = {
  sessionId: string
  scrollToLatestRequest: number
  tailActive: boolean
  termRef: RefObject<Terminal | null>
}

function isAtBottom(term: Terminal): boolean {
  return term.buffer.active.viewportY >= term.buffer.active.baseY
}

export function useTerminalFollow({
  sessionId, scrollToLatestRequest, tailActive, termRef,
}: FollowArgs) {
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
    // KNOWN LIMITATION, and not fixable from here: a provider whose TUI runs
    // on the ALTERNATE SCREEN owns its transcript internally and never evicts
    // a line into xterm scrollback, so viewportY === baseY always holds and
    // this call does nothing. OpenCode Terminal is exactly that case. Sending
    // the TUI's own scroll-to-bottom chord was tried and reverted: the binding
    // is user-configurable, so a user who has moved a destructive action onto
    // it would have Jump to Latest abort and revert their session. The
    // rebinding-immune route is OpenCode's POST /tui/execute-command, which
    // needs a served transport this runtime does not use yet. See the audit
    // doc for the full evidence.
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
        // WHY the engaged flag is reset too: detaching disposes the anchor, so
        // there is nothing left to restore, but this flag used to survive. The
        // xterm instance can be torn down and rebuilt under the SAME sessionId
        // — the effect that clears per-session state is keyed on sessionId and
        // does not re-run — so the next disengage found tailEngaged true and
        // saved null, took the restore branch, and silently dropped the user
        // back to wherever the fresh terminal happened to be instead of the
        // line they were reading. Engagement describes a live terminal, so it
        // has to end with one.
        tailEngagedRef.current = false
      }
    },
  }), [termRef])
}
