import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'

import type { AgentProviderKind } from '@shared/types/providerKind'
import {
  armRenderShapeCapture,
  disarmRenderShapeCapture,
} from '@renderer/features/feed/evidence/observer'

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
 * ONE mount query exists only for renderer reload recovery: a renderer that
 * mounts after recording already began will not receive the historical start
 * event. New recording starts use the push below. Repeating this query on a
 * schedule would recreate a polling protocol even though the authoritative
 * lifecycle is already event-driven.
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
    const check = (): void => {
      try {
        void window.api
          .isSessionRecording(sessionId)
          .then(state => {
            if (cancelled) return
            if (state.recording && state.generation) {
              armRenderShapeCapture(sessionId, state.generation)
            }
          })
          .catch(() => {
            /* recording capability off — observer stays disarmed */
          })
      } catch {
        /* preload absent (bare component tests) — observer stays disarmed */
      }
    }
    check()
    // PUSH is the authoritative arming path (live-test finding): under
    // auto-record the recorder starts on the session's FIRST event, which
    // for an idle restored pane is whenever the user first prompts it —
    // unboundedly after mount, past any retry schedule. Main announces the
    // start; the one mount query above remains as the reload-recovery belt (a
    // renderer that reloads MID-recording gets no fresh start event).
    let unsubscribe: (() => void) | undefined
    let unsubscribeStopping: (() => void) | undefined
    try {
      unsubscribe = window.api.onSessionRecordingStarted?.(payload => {
        if (!cancelled && payload.sessionId === sessionId) {
          armRenderShapeCapture(sessionId, payload.generation)
        }
      })
    } catch {
      /* preload absent — capture remains disarmed */
    }
    try {
      unsubscribeStopping = window.api.onSessionRecordingStopping?.(payload => {
        if (cancelled || payload.sessionId !== sessionId) return
        // Main owns the recorder lifetime; renderer owns the coalesced queue.
        // Echoing main's opaque generation closes that ownership loop without
        // guessing from a reusable sessionId. A stale renderer can finish its
        // own flush, but its acknowledgement cannot stop a newer recording.
        const generation = payload.generation
        if (!generation) return
        void (async () => {
          try {
            await disarmRenderShapeCapture(sessionId, generation)
          } finally {
            // session:exit appends final queue/surface releases to React state;
            // the dedicated observation outbox mirrors only after that state is
            // committed. Main's stopping notification can arrive before React
            // flushes the earlier IPC callback. Yield one renderer task so the
            // workspace layout effect sends those rows before this invoke asks
            // main to close the still-writable recorder. IPC ordering then
            // preserves reports-before-ack. Without this handoff, the shape
            // sidecar was complete while the named chronology ended with open
            // owners—the recorder grace period existed, but renderer ended it
            // before its other evidence producer had a chance to run.
            await new Promise<void>(resolve => window.setTimeout(resolve, 0))
            await window.api.finishSessionRecordingStop(sessionId, generation)
          }
        })()
          .catch(() => {
            /* main's grace timer is the fallback */
          })
      })
    } catch {
      /* preload absent — main's grace timer closes the recorder */
    }
    return () => {
      cancelled = true
      unsubscribe?.()
      unsubscribeStopping?.()
    }
  }, [sessionId])
  return (
    <RenderShapeCaptureContext.Provider value={binding}>
      {children}
    </RenderShapeCaptureContext.Provider>
  )
}
