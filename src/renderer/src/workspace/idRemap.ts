import type { SessionId, SessionMeta } from '@renderer/workspace/types'

// ============================================================================
// Session-id remapping — the single home for "a live session's id changed
// (old -> new); update every reference to it."
//
// Agent Code SessionIds are launch-local routing ids. Several operations mint
// a fresh id for an existing pane and must swap old -> new everywhere the old
// id is referenced: rehydrate (respawn on restart), replaceSession (reload /
// provider-switch / resume / rewind), reloadAgentSessions ("reload all"),
// undo-close. The tile tree, detached/buried records, Dispatch focus, and
// tiled lanes are remapped at those sites; this module covers the remaining
// cross-session references — SessionMeta relationship pointers and the pinned
// list — so they don't get left pointing at dead ids. Centralizing it here is
// what stops the next remap site from forgetting one of these (the same class
// of bug as the tiled-lane divergence).
// ============================================================================

/**
 * Remap a single SessionMeta's relationship pointers (linkedParentId,
 * orchestrationParentId, orchestrationRootId) through an old->new idMap.
 *
 * WHY these fields need the same remap as tile leaves: they are launch-local
 * SessionId references to OTHER sessions. Leaving them stale makes a restored
 * child agent render as a top-level row and breaks parent-scoped orchestration
 * MCP reads.
 *
 * WHY the fallback to the original id when there's no idMap entry: hibernated
 * sessions (detached/buried) intentionally don't respawn on rehydrate, so they
 * never appear in idMap but are still kept under their original id.
 * `knownSessionIds` is every id that survived (spawned new ids + hibernated
 * original ids). If the endpoint survived under either label the link is
 * honest; if it survived under neither, dropping the field is the correct
 * honest state. knownSessionIds defaults to empty so callers that pass only an
 * idMap get the strict "idMap-or-drop" behavior.
 */
export function remapSessionMetaRelationships(
  meta: SessionMeta,
  idMap: Map<SessionId, SessionId>,
  knownSessionIds: Set<SessionId> = new Set(),
): SessionMeta {
  const remap = (id?: SessionId): SessionId | undefined => {
    if (!id) return undefined
    const mapped = idMap.get(id)
    if (mapped) return mapped
    return knownSessionIds.has(id) ? id : undefined
  }
  const {
    linkedParentId,
    orchestrationParentId,
    orchestrationRootId,
    ...rest
  } = meta
  const remappedLinkedParentId = remap(linkedParentId)
  const remappedOrchestrationParentId = remap(orchestrationParentId)
  const remappedOrchestrationRootId = remap(orchestrationRootId)

  return {
    ...rest,
    ...(remappedLinkedParentId ? { linkedParentId: remappedLinkedParentId } : {}),
    ...(remappedOrchestrationParentId
      ? { orchestrationParentId: remappedOrchestrationParentId }
      : {}),
    ...(remappedOrchestrationRootId
      ? { orchestrationRootId: remappedOrchestrationRootId }
      : {}),
  }
}

/**
 * Apply remapSessionMetaRelationships across an ENTIRE sessions record.
 *
 * This is the form action sites want: when one session's id changes, it's not
 * enough to remap that session's own outbound pointers — every OTHER session
 * whose pointer references the changed id must be updated too. Mapping over the
 * whole record does both. knownSessionIds defaults to the record's own keys
 * (the set of sessions that exist after the remap), which is the right "did the
 * endpoint survive?" answer for the non-rehydrate sites.
 */
export function remapSessionsRelationships(
  sessions: Record<SessionId, SessionMeta>,
  idMap: Map<SessionId, SessionId>,
  knownSessionIds: Set<SessionId> = new Set(Object.keys(sessions) as SessionId[]),
): Record<SessionId, SessionMeta> {
  const out: Record<SessionId, SessionMeta> = {}
  for (const [id, meta] of Object.entries(sessions)) {
    out[id as SessionId] = remapSessionMetaRelationships(meta, idMap, knownSessionIds)
  }
  return out
}

/**
 * Remap a pinned-session list through an old->new idMap. Ids not in the map
 * (other sessions, unchanged) are kept as-is, so a pinned agent that gets a
 * fresh id (reload / provider-switch) stays pinned and follows to the new id
 * instead of silently dropping out of the Pinned section.
 */
export function remapPinnedSessionIds(
  pinned: readonly SessionId[],
  idMap: Map<SessionId, SessionId>,
): SessionId[] {
  return pinned.map(id => idMap.get(id) ?? id)
}
