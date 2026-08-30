import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'

import { reportLifecycle } from '@renderer/lifecycle/report'
import type { SessionId } from '@renderer/workspace/types'

export type VisibleSubmitSurface = {
  surface: 'render-selected' | 'queue-strip'
  submissionId: string
  renderCandidateId: string
  sessionRunId: string | null
  entryOrdinal?: number
}

export function reportHiddenSubmitSurface(
  sessionId: SessionId,
  prior: VisibleSubmitSurface,
): void {
  reportLifecycle('submit.surface', sessionId, {
    surface: prior.surface,
    visible: false,
    ...(prior.entryOrdinal === undefined ? {} : { entryOrdinal: prior.entryOrdinal }),
  }, {
    submissionId: prior.submissionId,
    renderCandidateId: prior.renderCandidateId,
    ...(prior.sessionRunId ? { sessionRunId: prior.sessionRunId } : {}),
  })
}

export function reportHiddenSubmitSurfaces(
  sessionId: SessionId,
  surfaces: ReadonlyMap<string, VisibleSubmitSurface>,
): void {
  for (const prior of surfaces.values()) reportHiddenSubmitSurface(sessionId, prior)
}

/**
 * Close the final visibility ledger when React removes a TileLeaf.
 *
 * WHY this is a separate mount-lifetime effect: the main visibility effect
 * depends on feed items, queues, provider, and session identity. Returning its
 * cleanup there would report every still-visible surface as hidden before each
 * ordinary rerender, manufacturing false flicker in the chronology. The ref
 * objects are mount-stable while their current values follow pane reuse, so a
 * one-time cleanup reads the exact last session and last committed surface set.
 */
export function useVisibleSubmitSurfaceUnmountCleanup(
  sessionIdRef: MutableRefObject<SessionId>,
  surfacesRef: MutableRefObject<ReadonlyMap<string, VisibleSubmitSurface>>,
): void {
  const mountGenerationRef = useRef(0)

  useEffect(() => {
    const generation = ++mountGenerationRef.current
    return () => {
      const sessionId = sessionIdRef.current
      const surfaces = new Map(surfacesRef.current)
      // WHY defer one microtask: development StrictMode intentionally runs an
      // effect's setup→cleanup→setup sequence without removing the tile. A
      // synchronous cleanup falsely closed every surface, while the replayed
      // visibility effect saw the same ref ledger and therefore did not reopen
      // them. A replay advances the generation before this task runs; a real
      // unmount cannot, so only the real lifetime boundary emits closes.
      queueMicrotask(() => {
        if (mountGenerationRef.current !== generation) return
        reportHiddenSubmitSurfaces(sessionId, surfaces)
      })
    }
  }, [sessionIdRef, surfacesRef])
}
