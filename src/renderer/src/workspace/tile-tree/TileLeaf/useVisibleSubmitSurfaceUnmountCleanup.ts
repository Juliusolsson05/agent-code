import { useEffect } from 'react'
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
  useEffect(() => () => {
    reportHiddenSubmitSurfaces(sessionIdRef.current, surfacesRef.current)
  }, [sessionIdRef, surfacesRef])
}
