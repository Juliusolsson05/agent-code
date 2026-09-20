import type { SessionId, SessionMeta } from '@renderer/workspace/types'

// ============================================================================
// Session-id remapping — the single home for "a live session's id changed
// (old -> new); update every reference to it."
//
// Agent Code SessionIds are launch-local routing ids. Several operations mint
// a fresh id for an existing pane and must swap old -> new everywhere the old
// id is referenced: rehydrate (respawn on restart), replaceSession (reload /
// provider-switch / resume / rewind), reloadAgentSessions ("reload all"),
// undo-close. The pool row and the stage's lanes are remapped at those sites
// (remapTiledLanes); this module covers the remaining cross-session references
// — SessionMeta relationship pointers and the pinned list — so they don't get
// left pointing at dead ids. Centralizing it here is
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
 * The relationship fields a SUCCESSOR inherits from the session it replaces.
 *
 * WHY this is an explicit list and not a spread of the predecessor (#879):
 * `replaceSession` builds the successor from spawn's FRESH metadata, on
 * purpose — cwd, kind, provider runtime and MCP scope are all properties of
 * the new backend, and inheriting them wholesale is how a provider switch
 * would keep pointing at the old provider. So each field the successor should
 * keep has to be named, and until this list existed the orchestration fields
 * simply were not.
 *
 * What that cost: a reloaded, switched, resumed or rewound orchestration child
 * became invisible to its parent, and `orchestration_wait_agents` computes
 * `done` over the parent-visible list — so the parent was told EVERY CHILD HAD
 * FINISHED while one was still working. `read_agent` failed, `close_run`
 * missed it, and Dispatch showed it top-level.
 *
 * `satisfies` so a typo is a compile error. What makes ADDING a relationship
 * field a decision rather than a silent omission is the type-level
 * completeness guard in successorRelationships.renderer.test.tsx: every
 * SessionMeta key named like a relationship must appear either here or in that
 * file's documented drop-list, or the build fails.
 */
export const SUCCESSOR_RELATIONSHIP_FIELDS = [
  'linkedParentId',
  'orchestrationParentId',
  'orchestrationRootId',
  'orchestrationRunId',
  'orchestrationRole',
  // Not a pointer, but it belongs to the same relationship: losing it makes
  // the create path re-deliver a bootstrap prompt to an agent that already
  // has one, on top of whatever it is doing.
  'orchestrationBootstrapPromptDelivered',
  // The inherited-context trio, kept as ONE unit because that is how creation
  // writes it and how `list_agents` projects it — carrying the flag without
  // the ids would read as "inherited from nowhere".
  //
  // `inheritedParentContext` is not decoration: together with the bootstrap
  // flag it is what makes `orchestrationVisibleEntries` cut the duplicated
  // parent history off the child's transcript. Drop it across a reload and the
  // parent's own old commentary becomes the child's "latest answer" in
  // read_agent and list_agents.
  //
  // Known residual, accepted: after a PROVIDER SWITCH the new backend mints a
  // different native id, so `inheritedProviderSessionId` then names a session
  // on the provider we left. That is tolerable because these ids are
  // provenance, never routing — nothing resumes, reads or mutates a transcript
  // through them (the only consumer is the read-only MCP projection), and the
  // historical fact they record ("this history was cloned from that parent")
  // stays true. If anything ever tries to OPEN one of them, it has to handle
  // the switch case itself.
  'inheritedParentContext',
  'inheritedParentProviderSessionId',
  'inheritedProviderSessionId',
] as const satisfies readonly (keyof SessionMeta)[]

/**
 * The subset of `meta` a successor must carry, with absent fields omitted
 * rather than set to undefined — an ordinary reloaded pane must not come back
 * looking like somebody's orchestration child.
 */
export function carriedRelationships(meta: SessionMeta | undefined): Partial<SessionMeta> {
  if (!meta) return {}
  const carried: Record<string, unknown> = {}
  for (const field of SUCCESSOR_RELATIONSHIP_FIELDS) {
    const value = meta[field]
    if (value !== undefined) carried[field] = value
  }
  return carried as Partial<SessionMeta>
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

// `remapGridRelatedSelections` lived here until #992 deleted the selection map
// it remapped (see TileTree.tsx).
