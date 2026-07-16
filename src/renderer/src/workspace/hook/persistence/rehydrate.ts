import { DEFAULT_PROVIDER, isSessionKind } from '@shared/types/providerKind'
import type { SessionBackendSnapshot } from '@shared/types/session'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { TileTabsState } from '@renderer/workspace/types'
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
import { remapTiledLanes } from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import { remapSessionMetaRelationships } from '@renderer/workspace/idRemap'
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
import {
  hasDurableProviderSession,
  resumableProviderSessionId,
  seedResumedRuntimeFields,
  withoutProvisionalProviderSession,
} from '@renderer/workspace/providerSessionIdentity'
import {
  projectSessionRecovery,
  type SessionRecoveryOutcome,
} from '@renderer/workspace/hook/persistence/recoveryProjection'

type WorkspaceRecoveryApi = Pick<Window['api'], 'recoverSession' | 'defaultCwd'>

// Reconcile every visible persisted leaf under its ORIGINAL Agent Code
// SessionId. Main either adopts the backend it already owns (renderer reload)
// or starts one replacement under that same local id (full app restart).
//
// WHY the local id is stable while providerSessionId is only a launch hint:
// clones and rewinds can legitimately share provider history, but exactly one
// main-owned process may own a local pane id. Remapping local ids on every
// renderer reload made a still-live backend unreachable and then duplicated
// its process, proxy, and MCP credentials. Recovery therefore compares local
// ownership in main and consumes providerSessionId only when cold-starting.
//
// A failed recovery is an honest, resolved renderer outcome. The visible pane,
// layout relationships, provider history id, MCP domains, and draft survive so
// the user can retry. Restore completion means every visible leaf received an
// outcome; it does not pretend every provider successfully started.
//
// The injectable adapter is intentionally tiny. Production defaults to the
// preload bridge, while the cross-layer restart test connects these exact two
// methods to a real SessionManager without booting packaged Electron. Keeping
// that test seam here prevents a mocked renderer-only test from "proving"
// atomicity that actually belongs to main.

export async function rehydrateWorkspace(
  persisted: PersistedWorkspace,
  refs: WorkspaceRefs,
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  setTileTabs: WorkspaceSetTileTabs,
  newTab: (cwd: string) => Promise<unknown>,
  recoveryApi: WorkspaceRecoveryApi = window.api,
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

  // WHY resolved and successful ids are separate:
  //
  // freshSessions holds BOTH visible recovered metadata and intentionally
  // hibernated metadata, all under their durable local ids. Membership alone
  // cannot tell us whether a visible leaf has received a recovery outcome,
  // because hibernated entries legitimately have no backend. A failed backend
  // recovery is still a RESOLVED renderer outcome:
  // its pane/draft must remain visible and autosave must be allowed to resume.
  // `liveBackendIds` is kept separately for honest restored-process telemetry.
  const resolvedIds = new Set<SessionId>()
  const liveBackendIds = new Set<SessionId>()
  const recoveryFailures = new Map<SessionId, string>()
  const backendSnapshots = new Map<SessionId, SessionBackendSnapshot>()
  const recoveryOutcomes = new Map<SessionId, SessionRecoveryOutcome>()

  const syncRecoveryProjection = (): void => {
    const projected = projectSessionRecovery({
      persistedSessions: persisted.sessions,
      ownedIds,
      liveProcessIds,
      outcomes: recoveryOutcomes,
    })
    idMap.clear()
    for (const [from, to] of projected.idMap) idMap.set(from, to)
    for (const id of Object.keys(freshSessions)) delete freshSessions[id]
    Object.assign(freshSessions, projected.sessions)
    resolvedIds.clear()
    for (const id of projected.resolvedIds) resolvedIds.add(id)
    liveBackendIds.clear()
    for (const id of projected.liveBackendIds) liveBackendIds.add(id)
    recoveryFailures.clear()
    for (const [id, message] of projected.failures) recoveryFailures.set(id, message)
    backendSnapshots.clear()
    for (const [id, snapshot] of projected.backendSnapshots) {
      backendSnapshots.set(id, snapshot)
    }
  }
  // This first projection seeds hibernated owned metadata without pretending
  // those panes have a backend. Later calls add one resolved visible outcome
  // at a time and are safe to publish incrementally.
  syncRecoveryProjection()

  const sanitizeRemappedNode = (n: TileNode): TileNode | null => {
    if (n.type === 'leaf') {
      return resolvedIds.has(n.sessionId) ? n : null
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

  // WHY this still projects through idMap even though recovery maps id->id:
  // the layout code historically consumes one common identity projection for
  // leaves, pins, lanes, and relationship fields. Keeping that path while the
  // recovery protocol stabilizes avoids a second representation and makes the
  // stable-id invariant explicit. A pin survives a failed recovery because
  // the corresponding failed pane remains in freshSessions; only an unowned
  // phantom row is dropped.
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
      // A visible recovered session has an explicit identity mapping; a
      // hibernated one does not. Both resolve to the same durable id today, but
      // keeping this projection shared with the rest of layout restoration
      // prevents detached records from becoming a special-case identity path.
      const mappedSessionId = idMap.get(entry.sessionId) ?? entry.sessionId
      out[mappedSessionId] = {
        ...entry,
        sessionId: mappedSessionId,
      }
    }
    return out
  }

  const buildRemappedSessions = (): Record<SessionId, SessionMeta> => {
    // WHY relationship fields are projected at commit time instead of when
    // each session finishes recovery:
    //
    // Rehydrate is concurrent and incremental. A child can resolve before its
    // parent, so the first partial commit must not permanently delete their
    // relationship just because the parent outcome is not published yet.
    // Re-projecting from raw persisted metadata on every commit lets links
    // appear as soon as both stable ids are known and drops only truly missing
    // ownership rows.
    const out: Record<SessionId, SessionMeta> = {}
    // WHY pass the freshSessions key set as `knownSessionIds`:
    //
    // remapSessionMetaRelationships needs to know which ids survived this
    // rehydrate so it can preserve hibernated->hibernated links and retain
    // failed-but-visible panes. The freshSessions key set is precisely the set
    // that may safely participate in renderer relationships.
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
      // it still exists in the newly-projected partial layout.
      const currentActiveTabStillExists = newTabs.some(t => t.id === prev.activeTabId)
      const activeTabId = currentActiveTabStillExists
        ? prev.activeTabId
        : restoredTileTabs?.focusedTabId
          ?? newTabs.find(t => t.id === persisted.activeTabId)?.id
          ?? newTabs[0].id

      // WHY Dispatch still uses the same identity projection as tile leaves:
      // focus and per-lane selections are references into the workspace
      // ownership graph, not independent state. Today every recovery mapping
      // is identity-preserving; using the shared projection still guarantees
      // that a missing/unowned target is cleared consistently while failed and
      // hibernated stable ids remain selectable. Splitting this into a special
      // "stable ids need no work" path would make future ownership changes
      // update tiles but silently forget Dispatch again.
      const remappedDispatchMode = remapTiledLanes(
        persisted.dispatchMode
          ? {
              ...persisted.dispatchMode,
              focusedSessionId: persisted.dispatchMode.focusedSessionId
                ? idMap.get(persisted.dispatchMode.focusedSessionId)
                : undefined,
            }
          : null,
        idMap,
      )

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
        const failure = recoveryFailures.get(newId)
        const backend = backendSnapshots.get(newId)
        const preserveObservedTerminalProcess = existing?.processStatus === 'failed' ||
          existing?.processStatus === 'exited'
        const snapshotIsNewer = backend !== null && backend !== undefined &&
          backend.input.revision > base.inputReadinessRevision
        out[newId] = {
          ...base,
          ...(draft && !base.draftInput ? { draftInput: draft } : {}),
          // WHY preserve an already-observed lifecycle state:
          //
          // Provider start is not a quiet boundary. Codex resume can
          // replay transcript entries and emit process exit before
          // spawnSession() resolves back to this rehydrate loop. The
          // restored pane should inherit that real status; forcing
          // "started/inputReady" here makes dead resumed sessions look
          // alive until the user presses Enter and hits the backend
          // guard.
          ...seedResumedRuntimeFields(existing, freshSessions[newId]),
          ...(failure
            ? {
                processStatus: 'failed' as const,
                processError: failure,
                inputReady: false,
              }
            : backend && !preserveObservedTerminalProcess
              ? {
                  processStatus: backend.lifecycle === 'live' ? 'started' as const : 'spawning' as const,
                  processError: null,
                  ...(snapshotIsNewer
                    ? {
                        inputReady: backend.input.ready,
                        inputReadinessRevision: backend.input.revision,
                      }
                    : {}),
                }
              : {}),
        }
      }
      for (const id of Object.keys(freshSessions)) {
        if (out[id]) continue
        const existing = prev[id]
        // WHY these restored sessions are deliberately dormant:
        //
        // Any id that reaches this loop exists in durable workspace metadata
        // but did not get a backend in the liveProcessIds spawn loop above.
        // That is intentional for detached/buried/orchestration-list sessions:
        // startup should restore the UI cheaply without forking every parked
        // provider process. Marking them started/inputReady was the broken
        // middle state: the pane looked writable while main had no PTY, so the
        // first post-restart prompt could be dropped before lazy wake ran. Keep
        // the feed/draft metadata, but make process readiness honest until
        // ensureSessionLive wakes this same SessionId.
        out[id] = {
          ...(existing ?? emptyRuntime()),
          hasOlderHistory: hasDurableProviderSession(freshSessions[id]),
          transcriptStatus: existing?.transcriptStatus === 'error' ||
            existing?.transcriptStatus === 'disconnected'
              ? existing.transcriptStatus
              : 'ready',
          transcriptError: existing?.transcriptError ?? null,
          processStatus: 'idle',
          processError: existing?.processError ?? null,
          inputReady: false,
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
          kind: meta.kind ?? DEFAULT_PROVIDER,
          hasProviderSessionId: Boolean(meta.providerSessionId),
          hasTmuxName: Boolean(meta.tmuxName),
        })
        try {
          // Persisted-kind validation (#394 phase 1). workspace.json is
          // parsed with no schema gate, so `meta.kind` can hold a string
          // this build has never heard of — most plausibly a session
          // written by a NEWER app version with an additional provider.
          // Before this guard, the unknown kind flowed into spawnSession,
          // main's getMainProvider threw, the catch below logged a
          // generic warn, and the pane silently vanished — worse, its
          // metadata was dropped from the next save, so downgrading the
          // app permanently destroyed the session (#394 §4.3).
          //
          // Policy: keep the metadata verbatim under its old id (the
          // pane shows as a dead leaf the user can close; a future build
          // that knows the kind restores it fully) and skip the spawn
          // loudly. Only `undefined` kind gets the DEFAULT_PROVIDER
          // back-compat treatment — that means "written before kind
          // existed", which really was Claude.
          if (meta.kind !== undefined && !isSessionKind(meta.kind)) {
            recoveryOutcomes.set(oldId, {
              status: 'failed',
              meta,
              message: `Unknown provider kind ${JSON.stringify(meta.kind)}; update Agent Code or close this pane.`,
            })
            syncRecoveryProjection()
            // eslint-disable-next-line no-console
            console.error(
              `[workspace] session ${oldId} has unknown provider kind ` +
              `${JSON.stringify(meta.kind)} — preserving metadata, not spawning. ` +
              `Was this workspace written by a newer Agent Code version?`,
            )
            commitRehydratedState()
            restoreSpan.end({ skipped: 'unknown-provider-kind' })
            return
          }
          const kind: SessionKind = meta.kind ?? DEFAULT_PROVIDER
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
          const resumeSessionId = kind !== 'terminal' ? resumableProviderSessionId(meta) : undefined
          const restoredMeta = withoutProvisionalProviderSession(meta)
          const recovery = await recoveryApi.recoverSession({
            sessionId: oldId,
            kind,
            cwd: meta.cwd,
            resumeSessionId,
            dangerousMode: kind !== 'terminal' ? refs.dangerousAgentsRef.current : undefined,
            useProxy: kind !== 'terminal' ? refs.useProxyStreamingRef.current : undefined,
            recoverTmuxName: kind === 'terminal' ? meta.tmuxName : undefined,
            builtInMcpDomains,
          })
          const newId = oldId
          if (!recovery.ok) {
            recoveryOutcomes.set(newId, {
              status: 'failed',
              meta: {
                ...restoredMeta,
                ...(builtInMcpDomains ? { builtInMcpDomains } : {}),
              },
              message: recovery.message,
            })
            syncRecoveryProjection()
            commitRehydratedState()
            restoreSpan.end({ outcome: recovery.code })
            return
          }
          if (recovery.snapshot.sessionId !== oldId) {
            // Main's recovery contract promises stable local identity. Treat a
            // violation as a retained failed pane instead of remapping the
            // whole workspace around an untrusted routing id.
            recoveryOutcomes.set(newId, {
              status: 'failed',
              meta: restoredMeta,
              message: 'Backend recovery returned a different local session id',
            })
            syncRecoveryProjection()
            commitRehydratedState()
            restoreSpan.end({ outcome: 'identity-mismatch' })
            return
          }
          // Carry the full meta forward — kind + providerSessionId +
          // tmuxName — so the next save cycle doesn't drop these and
          // cause the session to degrade on the NEXT reload.
          // tmuxName is replaced with whatever main reported
          // (recovered name when alive, fresh name when respawned).
          const recoveredMeta: SessionMeta = {
            ...restoredMeta,
            ...(builtInMcpDomains ? { builtInMcpDomains } : {}),
            ...(recovery.tmuxName ? { tmuxName: recovery.tmuxName } : {}),
          }
          recoveryOutcomes.set(newId, {
            status: 'live',
            meta: recoveredMeta,
            snapshot: recovery.snapshot,
          })
          syncRecoveryProjection()
          commitRehydratedState()
          if (kind !== 'terminal' && resumeSessionId) {
            void loadInitialHistoryForSession({
              sessionId: newId,
              meta: recoveredMeta,
              refs,
              setRuntimes,
            })
          }
          restoreSpan.end({ newId })
        } catch (err) {
          restoreSpan.fail(err)
          // Unexpected IPC/transport failures are still a resolved renderer
          // outcome. Keeping the local id, metadata, and draft makes retry
          // possible and prevents autosave from erasing the user's pane.
          recoveryOutcomes.set(oldId, {
            status: 'failed',
            meta,
            message: err instanceof Error && err.message.length > 0
              ? err.message
              : 'Backend recovery failed unexpectedly',
          })
          syncRecoveryProjection()
          commitRehydratedState()
          // eslint-disable-next-line no-console
          console.warn(`[workspace] failed to respawn ${meta.cwd}:`, err)
        }
      }),
  )

  if (!commitRehydratedState()) {
    const cwd = await recoveryApi.defaultCwd()
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
  // freshSessions also includes hibernated metadata seeds, so successful
  // process telemetry counts liveBackendIds while the autosave safety gate
  // counts resolvedIds (success OR retained failure).
  const restoredSessions = liveBackendIds.size
  const expectedSessions = liveProcessIds.size
  perf.mark('workspace.rehydrate.complete', {
    restoredSessions,
    expectedSessions,
    hibernatedSessions: ownedIds.size - liveProcessIds.size,
  })
  return {
    restoredSessions,
    expectedSessions,
    complete: resolvedIds.size === expectedSessions,
  }
}

// remapSessionMetaRelationships moved to src/renderer/src/workspace/idRemap.ts
// so the non-rehydrate remap sites (replaceSession, reloadAgentSessions) can
// share it without importing this persistence module (which would create an
// import cycle). Re-exported here to keep this file's historical import path
// working for any external consumer.
export { remapSessionMetaRelationships }
