import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'

import type { AgentProviderKind } from '@shared/types/providerKind'
import { armRenderShapeCapture } from '@renderer/features/feed/evidence/observer'

// Capture gate / session binding — Phase 2.
//
// WHY a context at all: the observation call sites (Block, EntryRow,
// SemanticLiveBlockRow) know the block they are painting but NOT which
// session owns it — Feed does. This context carries exactly that binding
// {sessionId, provider} down the tree.
//
// WHY the ARMED state is deliberately NOT in the context value: arming
// toggles mid-session (the recording toggle command), and a context value
// change re-renders every consumer — the Phase 2 exit gate says capture
// on/off must not alter the render tree. The value below is memoized per
// (sessionId, provider) and changes only when the pane itself changes;
// armed-ness lives in the observer's module map and is checked inside
// observeRenderShape (one Map.get when off).
export type RenderShapeCaptureBinding = {
  sessionId: string
  provider: AgentProviderKind | 'unknown'
}

export const RenderShapeCaptureContext = createContext<RenderShapeCaptureBinding | null>(null)

export function useRenderShapeCapture(): RenderShapeCaptureBinding | null {
  return useContext(RenderShapeCaptureContext)
}

/**
 * Mount-time sync between "is this session being recorded?" (main-process
 * truth) and the observer's armed set. Covers the two paths the toggle
 * command cannot: a renderer reload while a recording is live, and the
 * AGENT_CODE_SESSION_RECORD unattended-soak flag where recording starts in
 * main without any renderer command firing. The toggle command handles the
 * interactive path directly (it knows the answer without a round-trip).
 *
 * ARM-ONLY, never disarm (review finding: the round-trip's stale `false`
 * could land AFTER the user toggled recording on and silently disarm a
 * fresh capture — silent loss of exactly the evidence this feature
 * collects). There is nothing for a mount-sync disarm to fix anyway: module
 * state resets with the renderer on reload, and a recorder that stopped in
 * main is handled by the observer's own recorder-miss auto-disarm.
 *
 * Auto-record soak caveat: this one-shot query can also race a recorder
 * that auto-starts on the session's FIRST event (after Feed mounted). The
 * observer self-heals on the next remount, and interactive capture is the
 * primary path; soak users should expect arming from the first pane
 * mount/remount after events flow, not necessarily the first event.
 *
 * Unmount does NOT disarm: Feed unmounts on pane moves/reloads while the
 * recording keeps running, and disarming would drop the local counters a
 * final flush is supposed to persist. Disarm belongs to the stop command
 * and the recorder-miss auto-disarm.
 */
export function RenderShapeCaptureProvider({
  sessionId,
  provider,
  children,
}: {
  sessionId: string
  provider: AgentProviderKind | 'unknown'
  children: ReactNode
}) {
  const binding = useMemo<RenderShapeCaptureBinding>(
    () => ({ sessionId, provider }),
    [sessionId, provider],
  )
  useEffect(() => {
    let cancelled = false
    try {
      void window.api
        .isSessionRecording(sessionId)
        .then((recording: boolean) => {
          if (cancelled) return
          if (recording) armRenderShapeCapture(sessionId)
        })
        .catch(() => {
          /* recording capability off — observer stays disarmed */
        })
    } catch {
      /* preload absent (bare component tests) — observer stays disarmed */
    }
    return () => {
      cancelled = true
    }
  }, [sessionId])
  return (
    <RenderShapeCaptureContext.Provider value={binding}>
      {children}
    </RenderShapeCaptureContext.Provider>
  )
}
