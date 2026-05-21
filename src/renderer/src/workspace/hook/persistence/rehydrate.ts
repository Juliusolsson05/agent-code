import { emptyRuntime, type SessionRuntime, type TileTabsState } from '@renderer/workspace/workspaceState'
import type {
  BuriedPaneRecord,
  DetachedSessionRecord,
  SessionId,
  SessionKind,
  SessionMeta,
  Tab,
  TileNode,
} from '@renderer/workspace/types'
import { collectLeaves, remapTileTreeSessionIds } from '@renderer/workspace/tile-tree/treeOps'
import { sanitizeTileTabsState } from '@renderer/workspace/layout/helpers'
import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import {
  collectLiveProcessIds,
  collectOwnedSessionIds,
  collectUnownedSessionIds,
} from '@renderer/workspace/sessionOwnership'

import type {
  WorkspaceSetRuntimes,
  WorkspaceSetState,
  WorkspaceSetTileTabs,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import { normalizeSessionBuiltInMcpDomains } from '@renderer/workspace/mcpDomains'
import * as perf from '@renderer/performance/client'
import { loadInitialHistoryForSession } from '@renderer/workspace/hook/actions/initialHistory'

// Remap a persisted tree by replacing every sessionId with a freshly
// spawned one (spawn happens as we walk). Returns the remapped tree
// plus the old→new id mapping.
//
// Resume semantics: if the persisted SessionMeta carries a
// `providerSessionId`, we pass it to the spawn call as
// `resumeSessionId` so claude boots with `--resume <uuid>` and the
// full conversation history — tool calls, transcript, queue state,
// the lot — comes back. The Agent Code SessionId we mint here is a
// fresh routing key; CC's own session UUID is the thing we care
// about preserving.
//
// The providerSessionId is ALSO threaded into freshSessions[newId]
// so the runtime meta after rehydrate matches pre-reload state and
// the next save cycle writes it straight back. Without this, the
// first save after a resume would drop providerSessionId and the
// NEXT reload would lose context again.
//
// Failure modes:
//   - File missing / corrupted → CC will exit with a non-zero code
//     shortly after spawn. Surfaces via the exit event as "exited"
//     in the pane status strip. Not retried automatically — the
//     user can close the pane and open a fresh one.
//   - File locked by another process (rare) → same as above.
//   - Spawn itself throws (IPC failure) → caught below and logged;
//     the pane is simply missing from the rehydrated tree.

export async function rehydrateWorkspace(
  persisted: PersistedWorkspace,
  refs: WorkspaceRefs,
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  setTileTabs: WorkspaceSetTileTabs,
  newTab: (cwd: string) => Promise<unknown>,
): Promise<{ restoredSessions: number; expectedSessions: number; complete: boolean }> {
  perf.mark('workspace.rehydrate.start', {
    tabs: persisted.tabs.length,
    sessions: Object.keys(persisted.sessions).length,
    detachedSessions: Object.keys(persisted.detachedSessions ?? {}).length,
    buried: persisted.buried?.length ?? 0,
  })
  const idMap = new Map<SessionId, SessionId>()
  const freshSessions: Record<SessionId, SessionMeta> = {}
  const ownedIds = collectOwnedSessionIds(persisted)
  const liveProcessIds = collectLiveProcessIds(persisted)
  const staleIds = collectUnownedSessionIds(persisted)

  if (staleIds.length > 0) {
    // WHY log and drop instead of trying to repair by providerSessionId:
    //
    // Local SessionIds are the workspace ownership keys. providerSessionId is
    // provider history identity and can legitimately be duplicated by clone,
    // rewind, or failed restore paths. Using it as a repair key risks attaching
    // a hidden stale row to the wrong visible pane. The only safe restore set is
    // the ids already owned by tab leaves, detached sessions, or buried panes.
    // Dropping stale metadata here prevents invisible persisted rows from
    // becoming real backend processes/proxies during startup.
    // eslint-disable-next-line no-console
    console.warn('[workspace] dropping unowned persisted sessions during rehydrate:', staleIds)
  }

  // WHY we pre-populate freshSessions with hibernated metadata BEFORE the
  // spawn loop:
  //
  // The spawn loop only writes into freshSessions for sessions it actually
  // launches (live tile leaves). Detached and buried sessions are intentionally
  // skipped at spawn time — see sessionOwnership.ts for the live-vs-owned
  // split. But their metadata (cwd, kind, providerSessionId, builtInMcpDomains,
  // tmuxName) is durable user state: it has to survive into state.sessions so
  // the dispatch list and buried-panes UI can render them, and so that "wake
  // this hibernated agent" can find the providerSessionId to pass as
  // --resume.
  //
  // We seed under the ORIGINAL persisted sessionId, not a freshly minted one,
  // for two reasons:
  //   1. No process means no need for a fresh routing id. SessionIds are only
  //      "launch-local" when they identify a backend PTY; for hibernated
  //      records the id is just a stable key.
  //   2. detachedSessions / buried records reference these ids. Skipping the
  //      idMap remap keeps those references valid without any extra wiring.
  for (const [persistedId, meta] of Object.entries(persisted.sessions)) {
    if (!ownedIds.has(persistedId)) continue
    if (liveProcessIds.has(persistedId)) continue
    freshSessions[persistedId] = meta
  }

  // WHY `spawnedIds` is separate from `freshSessions`:
  //
  // freshSessions now holds BOTH live-spawned session metadata (under fresh
  // remapped ids) AND hibernated metadata (under original persisted ids — see
  // the seed loop above). The sanitize check below needs to drop tile leaves
  // whose backing process never actually started; freshSessions membership is
  // no longer sufficient for that check because hibernated entries are also
  // present. `spawnedIds` is the strict subset that did spawn — written only
  // inside the Promise.all loop after `window.api.spawnSession` resolves.
  const spawnedIds = new Set<SessionId>()

  const sanitizeRemappedNode = (n: TileNode): TileNode | null => {
    if (n.type === 'leaf') {
      return spawnedIds.has(n.sessionId) ? n : null
    }
    const a = sanitizeRemappedNode(n.a)
    const b = sanitizeRemappedNode(n.b)
    if (!a && !b) return null
    if (!a) return b
    if (!b) return a
    return { ...n, a, b }
  }

  const buildRemappedTabs = (): Tab[] =>
    persisted.tabs
      .map(t => {
        const remappedRoot = sanitizeRemappedNode(remapTileTreeSessionIds(t.root, idMap))
        if (!remappedRoot) return null
        const leaves = collectLeaves(remappedRoot)
        if (leaves.length === 0) return null
        const focused = idMap.get(t.focusedSessionId) ?? leaves[0]
        return {
          id: t.id,
          title: t.title,
          root: remappedRoot,
          focusedSessionId: focused,
        } satisfies Tab
      })
      .filter((t): t is Tab => t !== null)

  const buildRemappedBuried = (): BuriedPaneRecord[] =>
    (persisted.buried ?? [])
      .flatMap(entry => {
        // WHY fall back to the original sessionId when idMap has no entry:
        //
        // Buried panes are hibernated by design — no PTY, no rehydrate spawn,
        // metadata only. They never appear in idMap because the spawn loop
        // skipped them (see liveProcessIds filter). The previous behavior
        // ("drop if not in idMap") silently lost the buried pane on every
        // restart, defeating the purpose of "bury this for later". Use the
        // original sessionId as the key so the record round-trips intact.
        const mappedSessionId = idMap.get(entry.sessionId) ?? entry.sessionId
        const remapped: BuriedPaneRecord = {
          ...entry,
          id: mappedSessionId,
          sessionId: mappedSessionId,
        }
        if (entry.siblingLeafId) {
          remapped.siblingLeafId = idMap.get(entry.siblingLeafId) ?? entry.siblingLeafId
        }
        return [remapped]
      })

  // WHY remap pins through idMap: same reason as detached/buried.
  // Persisted SessionIds are pre-restart routing ids; every rehydrated
  // process gets a fresh id and the map is the only bridge. A pin that
  // can't be remapped (its source session failed to respawn) drops
  // silently — better an empty Pinned section than a phantom row that
  // resolves to nothing on focus.
  const buildRemappedPinnedSessionIds = (): SessionId[] => {
    // Defensive: hand-edited workspace.json could have non-array
    // pinnedSessionIds (or string-typed elements). Coerce to a clean
    // SessionId[] before remap to keep the runtime invariant
    // ("pinnedSessionIds is always SessionId[]") cheap to rely on.
    const raw = persisted.pinnedSessionIds
    const ids: SessionId[] = Array.isArray(raw)
      ? raw.filter((id): id is SessionId => typeof id === 'string' && id.length > 0)
      : []
    const remapped: SessionId[] = []
    const seen = new Set<SessionId>()
    for (const oldId of ids) {
      // WHY fall back to the original id when not in idMap:
      //
      // Same pattern as buildRemappedDetachedSessions / buildRemappedBuried.
      // Hibernated sessions are seeded into freshSessions under their original
      // persisted id and never get an idMap entry. A pin pointing at a parked
      // dispatch agent is durable user state — dropping it on every restart
      // (pre-fix behavior) silently emptied the Pinned section after each
      // detach. If the target didn't survive at all (orphaned pin), the
      // freshSessions guard keeps us honest by still dropping it.
      const mapped = idMap.get(oldId) ?? (freshSessions[oldId] ? oldId : undefined)
      if (!mapped) continue
      if (seen.has(mapped)) continue
      seen.add(mapped)
      remapped.push(mapped)
    }
    return remapped
  }

  const buildRemappedDetachedSessions = (): Record<SessionId, DetachedSessionRecord> => {
    const out: Record<SessionId, DetachedSessionRecord> = {}
    for (const entry of Object.values(persisted.detachedSessions ?? {})) {
      // WHY fall back to the original sessionId when idMap has no entry:
      //
      // Detached (hibernated) sessions are intentionally not respawned during
      // rehydrate — that is the entire point of the live-vs-owned split in
      // sessionOwnership.ts. They have no idMap entry because the spawn loop
      // skipped them. Pre-fix code dropped them here on every restart, which
      // silently emptied the dispatch parking pool after each launch. Falling
      // back to the original id preserves the record verbatim, ready to be
      // woken by an explicit user action later.
      //
      // When a mapping DOES exist (a session that was live, spawned, and then
      // got detached during a previous run — uncommon but possible), we honor
      // the remap so the new routing id matches the spawned process.
      const mappedSessionId = idMap.get(entry.sessionId) ?? entry.sessionId
      out[mappedSessionId] = {
        ...entry,
        sessionId: mappedSessionId,
      }
    }
    return out
  }

  const buildRemappedSessions = (): Record<SessionId, SessionMeta> => {
    // WHY relationship fields are remapped at commit time instead of when each
    // session finishes spawning:
    //
    // Rehydrate is intentionally concurrent and incremental. A child can spawn
    // before its parent, so `idMap` may not contain the parent old->new mapping
    // during that child's first commit. If we rewrote `freshSessions` eagerly,
    // that early partial commit would permanently drop the relationship and a
    // later parent spawn could not repair it. Keeping `freshSessions` as the
    // raw persisted metadata and projecting a remapped sessions map for each
    // commit lets relationships appear as soon as both endpoints have fresh
    // ids, while partial states avoid stale pre-restart pointers.
    const out: Record<SessionId, SessionMeta> = {}
    // WHY pass the freshSessions key set as `knownSessionIds`:
    //
    // remapSessionMetaRelationships needs to know which ids survived this
    // rehydrate so it can preserve hibernated->hibernated links. Spawned
    // sessions appear under their new id; hibernated sessions appear under
    // their original id. Either form is "still known" — the union is the
    // freshSessions key set computed right here.
    const knownSessionIds = new Set<SessionId>(Object.keys(freshSessions))
    for (const [sessionId, meta] of Object.entries(freshSessions)) {
      out[sessionId] = remapSessionMetaRelationships(meta, idMap, knownSessionIds)
    }
    return out
  }

  const buildRemappedTileTabs = (tabs: Tab[]): TileTabsState | null => {
    const persistedTileTabs = persisted.tileTabs
    if (!persistedTileTabs) return null
    const validTabIds = persistedTileTabs.tabIds.filter(id =>
      tabs.some(tab => tab.id === id),
    )
    return sanitizeTileTabsState({
      ...persistedTileTabs,
      tabIds: validTabIds,
    })
  }

  const commitRehydratedState = (): boolean => {
    const newTabs = buildRemappedTabs()
    if (newTabs.length === 0) return false

    const restoredTileTabs = buildRemappedTileTabs(newTabs)

    setState(prev => {
      // Incremental rehydrate commits can keep arriving long after
      // the first visible tabs are usable. Do not treat persisted
      // activeTabId as authoritative after the first commit: the
      // user may already have navigated to another restored tab, and
      // the next slow session finishing should not bounce focus back
      // to the startup tab. Preserve the current active tab whenever
      // it still exists in the newly-remapped partial layout.
      const currentActiveTabStillExists = newTabs.some(t => t.id === prev.activeTabId)
      const activeTabId = currentActiveTabStillExists
        ? prev.activeTabId
        : restoredTileTabs?.focusedTabId
          ?? newTabs.find(t => t.id === persisted.activeTabId)?.id
          ?? newTabs[0].id

      // dispatchMode.focusedSessionId is a SessionId that, like every
      // other persisted SessionId in the workspace (tab leaves, buried
      // records, detached records), needs to be remapped through the
      // idMap built by rehydrate. Without this remap the field carries
      // a pre-restart sessionId past restart, the dispatch UI silently
      // falls back to grid focus or first row, and any command that
      // targets dispatch focus operates on the wrong visible row.
      // Falling back to undefined when the old id failed to respawn
      // keeps the model honest — better to clear the focus than to
      // pretend a dead id is still selectable.
      const remappedDispatchMode = persisted.dispatchMode
        ? {
            ...persisted.dispatchMode,
            focusedSessionId: persisted.dispatchMode.focusedSessionId
              ? idMap.get(persisted.dispatchMode.focusedSessionId)
              : undefined,
          }
        : null

      return {
        tabs: newTabs,
        activeTabId,
        dispatchMode: remappedDispatchMode,
        sessions: buildRemappedSessions(),
        detachedSessions: buildRemappedDetachedSessions(),
        buried: buildRemappedBuried(),
        pinnedSessionIds: buildRemappedPinnedSessionIds(),
      }
    })
    setTileTabs(prev => {
      if (!restoredTileTabs) return null
      if (!prev) return restoredTileTabs
      if (!restoredTileTabs.tabIds.includes(prev.focusedTabId)) {
        return restoredTileTabs
      }
      // Same invariant as activeTabId above, but for TileTabs'
      // internal focus. Rehydrate still owns the tab membership as
      // panes come online; the user's focused tiled tab survives
      // each later partial commit.
      return {
        ...restoredTileTabs,
        focusedTabId: prev.focusedTabId,
      }
    })
    // WHY commit runtimes incrementally during rehydrate:
    //
    // Boot used to await every respawn before publishing *any*
    // restored tabs. One slow / wedged session kept `tabs: []`, so
    // after restart the user only saw the `+` button even though
    // workspace.json contained a full layout. We now publish
    // whatever subset has already rehydrated so the shell surfaces
    // real tabs immediately and fills in the remaining panes as
    // their sessions come back.
    //
    // We still merge with prev because resume-side transcript
    // events can arrive synchronously inside `session.start()`
    // before spawnSession() resolves. Replacing the runtime object
    // here would clobber those early entries and make restored
    // panes open blank.
    setRuntimes(prev => {
      const out: Record<SessionId, SessionRuntime> = {}
      for (const [oldId, newId] of idMap.entries()) {
        const existing = prev[newId]
        const base = existing ?? emptyRuntime()
        const draft = persisted.drafts?.[oldId]
        out[newId] = {
          ...base,
          ...(draft && !base.draftInput ? { draftInput: draft } : {}),
          hasOlderHistory: Boolean(freshSessions[newId]?.providerSessionId),
          transcriptStatus: base.transcriptStatus === 'ready' || base.transcriptStatus === 'error'
            ? base.transcriptStatus
            : freshSessions[newId]?.providerSessionId ? 'loading' : 'ready',
          transcriptError: base.transcriptError,
          // WHY preserve an already-observed lifecycle state:
          //
          // Provider start is not a quiet boundary. Codex resume can
          // replay transcript entries and emit process exit before
          // spawnSession() resolves back to this rehydrate loop. The
          // restored pane should inherit that real status; forcing
          // "started/inputReady" here makes dead resumed sessions look
          // alive until the user presses Enter and hits the backend
          // guard.
          processStatus: existing && existing.processStatus !== 'idle'
            ? existing.processStatus
            : 'started',
          processError: existing?.processError ?? null,
          inputReady: existing && existing.processStatus !== 'idle'
            ? existing.inputReady
            : true,
        }
      }
      for (const id of Object.keys(freshSessions)) {
        if (out[id]) continue
        const existing = prev[id]
        out[id] = {
          ...(existing ?? emptyRuntime()),
          hasOlderHistory: Boolean(freshSessions[id]?.providerSessionId),
          transcriptStatus:
            existing?.transcriptStatus === 'ready' || existing?.transcriptStatus === 'error'
              ? existing.transcriptStatus
              : freshSessions[id]?.providerSessionId ? 'loading' : 'ready',
          transcriptError: existing?.transcriptError ?? null,
          processStatus: existing && existing.processStatus !== 'idle'
            ? existing.processStatus
            : 'started',
          processError: existing?.processError ?? null,
          inputReady: existing && existing.processStatus !== 'idle'
            ? existing.inputReady
            : true,
        }
      }
      return out
    })
    return true
  }

  // Spawn live tile-leaf sessions concurrently. A single slow respawn
  // must not block the entire tab strip from coming back.
  //
  // WHY this filter is liveProcessIds, not ownedIds (the original bug):
  //
  // ownedIds includes detached and buried sessions — i.e. parked agents the
  // user has explicitly removed from their visible workspace. The previous
  // code spawned every owner on rehydrate, which meant every time you parked
  // dispatch agents and restarted, all of them came back as live processes
  // (plus a per-session mitmdump) regardless of whether you intended to use
  // them. With ~40 parked dispatch agents accumulating in detachedSessions,
  // a single restart fork-bombed the machine with 40 claude + 40 mitmdump
  // processes, all started in this Promise.all in the same ~3 seconds.
  //
  // liveProcessIds is the strictly smaller set the user is going to be
  // exposed to on launch — current tile-tree leaves only. Hibernated
  // sessions get metadata-restored above (so they're still rendered in
  // dispatch lists and revivable later), but no PTY/mitmdump/MCP host
  // is created until the user explicitly wakes one.
  await Promise.all(
    Object.entries(persisted.sessions)
      .filter(([oldId]) => liveProcessIds.has(oldId))
      .map(async ([oldId, meta]) => {
        const restoreSpan = perf.span('workspace.rehydrate.session', {
          oldId,
          kind: meta.kind ?? 'claude',
          hasProviderSessionId: Boolean(meta.providerSessionId),
          hasTmuxName: Boolean(meta.tmuxName),
        })
        try {
          const kind: SessionKind = meta.kind ?? 'claude'
          const builtInMcpDomains =
            kind !== 'terminal'
              ? normalizeSessionBuiltInMcpDomains(meta.builtInMcpDomains)
              : undefined
          // For terminal sessions with a persisted tmuxName, pass it
          // as recoverTmuxName so main re-attaches the alive tmux
          // session (or falls back to fresh spawn if it died). Agents
          // ignore recoverTmuxName at the main side; safe to omit.
          //
          // WHY MCP domains are threaded through rehydrate:
          // workspace.json stores durable domain names; main mints fresh
          // loopback URLs/tokens for every new provider process. If rehydrate
          // respawns without the saved domains, the pane visually restores but
          // its tool surface silently changes underneath the user.
          const { sessionId: newId, tmuxName: nextTmuxName } = await window.api.spawnSession({
            kind,
            cwd: meta.cwd,
            resumeSessionId: kind !== 'terminal' ? meta.providerSessionId : undefined,
            dangerousMode: kind !== 'terminal' ? refs.dangerousAgentsRef.current : undefined,
            useProxy: kind !== 'terminal' ? refs.useProxyStreamingRef.current : undefined,
            recoverTmuxName: kind === 'terminal' ? meta.tmuxName : undefined,
            builtInMcpDomains,
          })
          idMap.set(oldId, newId)
          spawnedIds.add(newId)
          // Carry the full meta forward — kind + providerSessionId +
          // tmuxName — so the next save cycle doesn't drop these and
          // cause the session to degrade on the NEXT reload.
          // tmuxName is replaced with whatever main reported
          // (recovered name when alive, fresh name when respawned).
          freshSessions[newId] = {
            ...meta,
            ...(builtInMcpDomains ? { builtInMcpDomains } : {}),
            ...(nextTmuxName ? { tmuxName: nextTmuxName } : {}),
          }
          commitRehydratedState()
          if (kind !== 'terminal' && freshSessions[newId].providerSessionId) {
            void loadInitialHistoryForSession({
              sessionId: newId,
              meta: freshSessions[newId],
              refs,
              setRuntimes,
            })
          }
          restoreSpan.end({ newId })
        } catch (err) {
          restoreSpan.fail(err)
          // eslint-disable-next-line no-console
          console.warn(`[workspace] failed to respawn ${meta.cwd}:`, err)
        }
      }),
  )

  if (!commitRehydratedState()) {
    const cwd = await window.api.defaultCwd()
    await newTab(cwd)
  }
  // WHY restored/expected count live-spawned sessions, not owned:
  //
  // `complete` here gates autosave (useBootstrap reads it to decide whether
  // disk can be overwritten with the in-memory model). The invariant the gate
  // enforces is "no visible pane was silently dropped" — i.e. every leaf in
  // the user's tile tree got a working backend process. Hibernated sessions
  // (detached + buried) deliberately do not spawn a process during rehydrate;
  // counting them against expected would make `complete` false forever for
  // anyone who has parked a dispatch agent, permanently disabling autosave.
  // freshSessions also includes hibernated metadata seeds, so we count
  // `spawnedIds` (strict subset that actually started) instead.
  const restoredSessions = spawnedIds.size
  const expectedSessions = liveProcessIds.size
  perf.mark('workspace.rehydrate.complete', {
    restoredSessions,
    expectedSessions,
    hibernatedSessions: ownedIds.size - liveProcessIds.size,
  })
  return {
    restoredSessions,
    expectedSessions,
    complete: restoredSessions === expectedSessions,
  }
}

export function remapSessionMetaRelationships(
  meta: SessionMeta,
  idMap: Map<SessionId, SessionId>,
  knownSessionIds: Set<SessionId> = new Set(),
): SessionMeta {
  // WHY these SessionMeta fields need the same old->new remap as tile leaves:
  //
  // Agent Code SessionIds are launch-local routing ids. Rehydrate respawns
  // live backend processes, so every persisted reference to another session
  // must cross the idMap boundary. Tile leaves, detached records, buried
  // records, pins, and Dispatch focus already do this. `linkedParentId`,
  // `orchestrationParentId`, and `orchestrationRootId` are the same kind of
  // relationship pointer; leaving them untouched makes restored child agents
  // render as top-level rows and breaks parent-scoped orchestration MCP reads.
  //
  // WHY the fallback to the original id when no idMap entry exists:
  //
  // Hibernated sessions (detached + buried) intentionally do not respawn during
  // rehydrate, so they never appear in idMap. Their metadata is still seeded
  // into `freshSessions` under the original persisted id (no fresh routing id
  // is needed because no process was created). A hibernated → hibernated
  // relationship link must therefore resolve via "is this endpoint still
  // known?" rather than "is it in idMap?". `knownSessionIds` is the set of
  // every sessionId that survived this rehydrate — both spawned (new ids) and
  // hibernated (original ids). If the endpoint survived under either label,
  // the link is honest; if it survived under no label, omitting the field is
  // the correct honest state (the relationship endpoint is gone).
  //
  // Backward compatibility: knownSessionIds is optional so non-rehydrate
  // callers (if any) get the old "idMap or drop" behavior without surprise.
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
