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

export type VisibleSubmitSurfaceOwner = object

type VisibleSubmitSurfaceClaim = {
  sessionId: SessionId
  surface: VisibleSubmitSurface
  owners: Set<VisibleSubmitSurfaceOwner>
}

type VisibleSubmitSurfaceOwnerState = {
  sessionId: SessionId
  claimKeys: Set<string>
}

// TileLeaf normally has one mounted instance per session, but atomic workspace
// takeovers (for example TileTree -> Spotlight) replace that instance while
// preserving the exact same painted row. React can run the successor's passive
// effect before the predecessor's deferred unmount close. A component-local
// ledger cannot distinguish that handoff from a real disappearance, so it can
// write `visible:true` followed by a stale `visible:false` for a row that never
// left the screen. These process-local claims make visibility an aggregate of
// all mounted owners. The first owner opens a row and the last owner closes it;
// an overlap during an atomic handoff produces no false edge.
const visibleSubmitSurfaceClaims = new Map<string, VisibleSubmitSurfaceClaim>()
const visibleSubmitSurfaceOwners = new Map<
  VisibleSubmitSurfaceOwner,
  VisibleSubmitSurfaceOwnerState
>()

function visibleSubmitSurfaceClaimKey(
  sessionId: SessionId,
  surface: VisibleSubmitSurface,
): string {
  // JSON avoids delimiter ambiguity if a future provider changes an opaque id
  // format. These values are diagnostic identities, not user-visible text, but
  // the registry must still never merge two distinct tuples accidentally.
  return JSON.stringify([
    sessionId,
    surface.surface,
    surface.sessionRunId,
    surface.submissionId,
    surface.renderCandidateId,
  ])
}

export function reportVisibleSubmitSurface(
  sessionId: SessionId,
  current: VisibleSubmitSurface,
): void {
  reportLifecycle('submit.surface', sessionId, {
    surface: current.surface,
    visible: true,
    ...(current.entryOrdinal === undefined ? {} : { entryOrdinal: current.entryOrdinal }),
  }, {
    submissionId: current.submissionId,
    renderCandidateId: current.renderCandidateId,
    ...(current.sessionRunId ? { sessionRunId: current.sessionRunId } : {}),
  })
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
 * Publish one mounted TileLeaf's complete visible-surface set.
 *
 * WHY this owns transition emission instead of returning a diff to TileLeaf:
 * only the shared registry knows whether another instance already paints the
 * same candidate. Letting each instance emit its local diff recreates the
 * remount race even if unmount cleanup itself is shared.
 */
export function commitVisibleSubmitSurfaceOwner(
  owner: VisibleSubmitSurfaceOwner,
  sessionId: SessionId,
  surfaces: ReadonlyMap<string, VisibleSubmitSurface>,
): void {
  const priorOwner = visibleSubmitSurfaceOwners.get(owner)
  const nextByClaimKey = new Map<string, VisibleSubmitSurface>()
  for (const surface of surfaces.values()) {
    nextByClaimKey.set(visibleSubmitSurfaceClaimKey(sessionId, surface), surface)
  }

  for (const claimKey of priorOwner?.claimKeys ?? []) {
    if (priorOwner?.sessionId === sessionId && nextByClaimKey.has(claimKey)) continue
    const claim = visibleSubmitSurfaceClaims.get(claimKey)
    if (!claim) continue
    claim.owners.delete(owner)
    if (claim.owners.size > 0) continue
    visibleSubmitSurfaceClaims.delete(claimKey)
    reportHiddenSubmitSurface(claim.sessionId, claim.surface)
  }

  for (const [claimKey, surface] of nextByClaimKey) {
    const existing = visibleSubmitSurfaceClaims.get(claimKey)
    if (existing) {
      existing.owners.add(owner)
      // entryOrdinal is presentation metadata and can become known after the
      // first owner opened the claim. Retain the newest complete description so
      // a later final close carries the best ordinal without emitting a fake
      // visibility transition merely because metadata improved.
      existing.surface = surface
      continue
    }
    visibleSubmitSurfaceClaims.set(claimKey, {
      sessionId,
      surface,
      owners: new Set([owner]),
    })
    reportVisibleSubmitSurface(sessionId, surface)
  }

  if (nextByClaimKey.size === 0) {
    visibleSubmitSurfaceOwners.delete(owner)
  } else {
    visibleSubmitSurfaceOwners.set(owner, {
      sessionId,
      claimKeys: new Set(nextByClaimKey.keys()),
    })
  }
}

function releaseVisibleSubmitSurfaceOwner(
  owner: VisibleSubmitSurfaceOwner,
  fallbackSessionId: SessionId,
  fallbackSurfaces: ReadonlyMap<string, VisibleSubmitSurface>,
): void {
  const registered = visibleSubmitSurfaceOwners.get(owner)
  if (!registered) {
    // The hook can be used without the TileLeaf commit effect in isolated
    // harnesses, and a future mount could be removed before its visibility
    // effect ever runs. Preserve the old fail-honest cleanup in that narrow
    // case rather than silently leaving the captured local ledger open.
    reportHiddenSubmitSurfaces(fallbackSessionId, fallbackSurfaces)
    return
  }
  commitVisibleSubmitSurfaceOwner(owner, registered.sessionId, new Map())
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
): VisibleSubmitSurfaceOwner {
  const mountGenerationRef = useRef(0)
  const ownerRef = useRef<VisibleSubmitSurfaceOwner>({})

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
        releaseVisibleSubmitSurfaceOwner(ownerRef.current, sessionId, surfaces)
      })
    }
  }, [sessionIdRef, surfacesRef])

  return ownerRef.current
}
