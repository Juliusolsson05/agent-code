import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'

// Follow behavior for raw agent terminal surfaces (AgentTerminalLeaf) — the
// xterm counterpart of what Feed does for the rendered surface:
//   - Jump to Latest: the workspace bumps `runtime.scrollToLatestRequest`
//     whenever the user asks to return to the bottom (palette command, prompt
//     send). Feed scrolls its DOM scroller; a raw pane scrolls the xterm
//     viewport instead. Nothing consumed this counter on the terminal surface
//     before, so the command silently did nothing there.
//   - Tail (auto-follow): mirrors Feed's semantics — pin to bottom while
//     active, re-pin if the user scrolls away, and restore the pre-tail
//     viewport line on disengage so following is non-destructive. Feed
//     protects the saved position for the same reason (see Feed.tsx "WHY
//     tailing deliberately does NOT persist").
//
// WHY a hook instead of inline effects in AgentTerminalLeaf: the leaf's xterm
// mount effect is deliberately keyed on [sessionId] alone (remounting xterm on
// every runtime change would lose scrollback and re-attach the PTY), so
// runtime-driven behavior must live outside that effect and reach the terminal
// through refs. Collecting it here also gives the renderer tests one unit to
// target. The hook MUST be called before the leaf's mount effect — see the
// wiring comment in AgentTerminalLeaf.

/** Viewport is at bottom when its top line plus rows covers the buffer. */
export function isXtermViewportAtBottom(term: Terminal): boolean {
  const buffer = term.buffer.active
  return buffer.viewportY >= buffer.length - term.rows
}

type FollowArgs = {
  /** Live runtime counter; every increment is one jump-to-latest request. */
  scrollToLatestRequest: number
  /** Computed tail verdict (per-session Tail OR Tail All, masked by visibility). */
  tailActive: boolean
  /** The leaf's terminal ref; null until the mount effect creates xterm. */
  termRef: RefObject<Terminal | null>
}

export type AgentTerminalFollowHandle = {
  /** Tail verdict for the PTY write path inside the leaf's mount effect. */
  readonly tailActiveRef: Readonly<{ current: boolean }>
  /** Wire re-pin-on-user-scroll to a freshly created Terminal instance. */
  attach: (term: Terminal) => () => void
}

export function useAgentTerminalFollow({
  scrollToLatestRequest,
  tailActive,
  termRef,
}: FollowArgs): AgentTerminalFollowHandle {
  // WHY render-time assignment (mirroring runtimeRef in AgentTerminalLeaf):
  // the PTY subscriber in the mount effect reads this ref at IPC-event time,
  // long after any effect ordering, and the mount effect itself must never
  // re-run for follow-state changes.
  const tailActiveRef = useRef(tailActive)
  tailActiveRef.current = tailActive

  // Jump to Latest. WHY a baseline ref: the counter can already be non-zero
  // from the session's rendered-surface life, and remounting the pane must
  // not replay an old request against a fresh xterm — the attach replay
  // already leaves a fresh terminal at the bottom.
  const jumpBaselineRef = useRef<number | null>(null)
  useEffect(() => {
    if (jumpBaselineRef.current === null) {
      jumpBaselineRef.current = scrollToLatestRequest
      return
    }
    if (scrollToLatestRequest === jumpBaselineRef.current) return
    jumpBaselineRef.current = scrollToLatestRequest
    termRef.current?.scrollToBottom()
  }, [scrollToLatestRequest, termRef])

  // Tail engage/disengage. Non-destructive like Feed: only a viewport that was
  // genuinely scrolled up has a position worth restoring; engaging while at
  // bottom saves nothing and disengage leaves the bottom. On mount with tail
  // already on, this effect runs before xterm exists (declaration order — see
  // the leaf wiring), so nothing is saved and disengage keeps the bottom the
  // attach replay left us at.
  const tailEngagedRef = useRef(false)
  const savedViewportYRef = useRef<number | null>(null)
  useEffect(() => {
    const activeTerm = termRef.current
    if (tailActive && !tailEngagedRef.current) {
      tailEngagedRef.current = true
      if (activeTerm) {
        savedViewportYRef.current = isXtermViewportAtBottom(activeTerm)
          ? null
          : activeTerm.buffer.active.viewportY
        activeTerm.scrollToBottom()
      }
      return
    }
    if (!tailActive && tailEngagedRef.current) {
      tailEngagedRef.current = false
      const saved = savedViewportYRef.current
      savedViewportYRef.current = null
      if (activeTerm && saved !== null) {
        const buffer = activeTerm.buffer.active
        buffer.viewportY = Math.min(saved, Math.max(0, buffer.length - activeTerm.rows))
      }
    }
  }, [tailActive, termRef])

  // Stable handle: the leaf's mount effect is keyed on [sessionId] and must
  // not be invalidated by follow-state churn.
  return useMemo<AgentTerminalFollowHandle>(() => ({
    tailActiveRef,
    attach: mountedTerm => {
      // Feed re-pins on the scroll event itself. scrollToBottom also fires
      // onScroll, but the handler then sees an at-bottom viewport and no-ops,
      // so the loop self-terminates. Mouse-mode TUIs forward wheel events to
      // the app instead of xterm scrollback, so this only acts on genuine
      // viewport movement.
      const disposable = mountedTerm.onScroll(() => {
        if (!tailActiveRef.current) return
        if (isXtermViewportAtBottom(mountedTerm)) return
        mountedTerm.scrollToBottom()
      })
      return () => disposable.dispose()
    },
  }), [])
}
