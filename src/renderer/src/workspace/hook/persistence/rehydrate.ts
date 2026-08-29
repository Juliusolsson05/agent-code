import {
  DEFAULT_PROVIDER,
  isAgentProviderKind,
  isAgentSessionKind,
  isSessionKind,
} from '@shared/types/providerKind'
import type {
  SessionBackendSnapshot,
  SessionRecoverFailureCode,
  SessionRecoverOptions,
  SessionRecoverResult,
} from '@shared/types/session'
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
import {
  keepTiledLaneSessions,
  remapTiledLanes,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
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
import { resolveSessionBuiltInMcpDomains } from '@renderer/workspace/mcpDomains'
import * as perf from '@renderer/performance/client'
import { reportLifecycle } from '@renderer/lifecycle/report'
import { loadInitialHistoryForSession } from '@renderer/workspace/hook/actions/initialHistory'
import {
  resumableProviderSessionId,
  seedResumedRuntimeFields,
  withoutProvisionalProviderSession,
} from '@renderer/workspace/providerSessionIdentity'
import {
  projectSessionRecovery,
  type SessionRecoveryOutcome,
} from '@renderer/workspace/hook/persistence/recoveryProjection'

type WorkspaceRecoveryApi = Pick<
  Window['api'],
  'recoverSession' | 'cancelSessionRecovery' | 'defaultCwd'
>

const DEFAULT_SESSION_RECOVERY_TIMEOUT_MS = 30_000

async function recoverSessionBeforeDeadline(
  recoveryApi: WorkspaceRecoveryApi,
  options: SessionRecoverOptions,
  timeoutMs: number,
): Promise<SessionRecoverResult> {
  const recoveryToken = options.recoveryToken ?? globalThis.crypto.randomUUID()
  const generationOptions: SessionRecoverOptions = {
    ...options,
    recoveryToken,
  }
  let timeout: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<SessionRecoverResult>(resolve => {
    timeout = setTimeout(() => {
      // WHY timeout actively cancels the matching main recovery claim instead
      // of merely giving up in the renderer: an unresolved provider start
      // would otherwise keep its recovery claim, MCP credentials, and autosave
      // bootstrap gate alive
      // indefinitely. The cancellation request itself is fire-and-forget here:
      // main deliberately keeps its generation fence until both startup and
      // teardown settle, including a second stop if the provider materializes
      // resources after this renderer deadline.
      void recoveryApi.cancelSessionRecovery({
        sessionId: options.sessionId,
        kind: options.kind,
        cwd: options.cwd,
        recoveryToken,
      }).catch(() => undefined)
      resolve({
        ok: false,
        code: 'cancelled',
        retryable: true,
        message: 'Session recovery timed out. Retry when the provider is available.',
      })
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      recoveryApi.recoverSession(generationOptions),
      deadline,
    ])
  } finally {
    if (timeout !== null) clearTimeout(timeout)
  }
}

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
  recoveryTimeoutMs = DEFAULT_SESSION_RECOVERY_TIMEOUT_MS,
): Promise<{ restoredSessions: number; expectedSessions: number; complete: boolean }> {
  perf.mark('workspace.rehydrate.start', {
    tabs: persisted.tabs.length,
    sessions: Object.keys(persisted.sessions).length,
    detachedSessions: Object.keys(persisted.detachedSessions ?? {}).length,
    buried: persisted.buried?.length ?? 0,
  })
  // The always-on twin of the perf mark above. The perf channel is gated behind
  // AGENT_CODE_PERF and is off by default, which is exactly why no cold boot has
  // ever been measured. Shape matters here: #258's fork bomb (49 persisted, 9
  // visible, 40 detached → 40 claude + 40 mitmdump, loadavg 906) is a specific
  // ratio between these counts, and this is the first record of that ratio at
  // the moment restore begins.
  reportLifecycle('rehydrate.start', undefined, {
    tabs: persisted.tabs.length,
    leaves: Object.keys(persisted.sessions).length,
    detached: Object.keys(persisted.detachedSessions ?? {}).length,
    buried: persisted.buried?.length ?? 0,
  })
  const rehydrateStartedAt = Date.now()
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
  const recoveryFailureCodes = new Map<SessionId, SessionRecoverFailureCode>()
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
    recoveryFailureCodes.clear()
    for (const [id, code] of projected.failureCodes) recoveryFailureCodes.set(id, code)
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
      // WHY layout membership follows durable ownership, not provider timing:
      // an unresolved or failed pane is still user-owned workspace state. The
      // runtime below communicates "starting" or "failed" honestly while the
      // stable leaf remains closable/retryable from the first paint.
      return freshSessions[n.sessionId] ? n : null
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
      // WHY metadata survival is the gate here, not the presence of the raw
      // detached record:
      //
      // collectOwnedSessionIds rejects a detached agent when its project tab
      // no longer exists. Copying the raw record anyway would leave half of the
      // corrupted pair in renderer state: no SessionMeta/runtime, but a ghost
      // Dispatch owner that autosave and selectors must keep reasoning about.
      // freshSessions is the already-normalized ownership set, so closing the
      // projection over it repairs old workspace files on their first launch.
      if (!freshSessions[mappedSessionId]) continue
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

  let initialWorkspacePublished = false
  const publishedSessionBaselines = new Map<SessionId, SessionMeta>()

  const buildRecoveredRuntime = (
    sessionId: SessionId,
    existing: SessionRuntime | undefined,
  ): SessionRuntime => {
    const draft = persisted.drafts?.[sessionId]
    const failure = recoveryFailures.get(sessionId)
    const failureCode = recoveryFailureCodes.get(sessionId)
    const ownershipQuarantined = failureCode === 'ownership-conflict'
    // WHY an ownership conflict starts from a clean backend-derived runtime:
    // the other backend can emit started/screen/JSONL/semantic events before
    // recover's conflict result reaches this renderer. Reusing `existing`
    // would retain cross-project content even if later feed events are
    // quarantined. Draft fields are renderer-local user work and survive; all
    // provider/feed fields are discarded until main proves matching ownership.
    const base = ownershipQuarantined
      ? {
          ...emptyRuntime(),
          draftInput: existing?.draftInput ?? draft ?? '',
          draftImages: existing?.draftImages ?? [],
        }
      : existing ?? emptyRuntime()
    const backend = backendSnapshots.get(sessionId)
    const visibleProcess = liveProcessIds.has(sessionId)
    const preserveObservedTerminalProcess =
      (existing?.processStatus === 'failed' || existing?.processStatus === 'exited') &&
      existing.recoveryFailureCode === null
    const snapshotIsAuthoritative = backend !== undefined &&
      backend.input.revision >= base.inputReadinessRevision
    const seeded: SessionRuntime = {
      ...base,
      ...(draft && !base.draftInput ? { draftInput: draft } : {}),
      ...seedResumedRuntimeFields(existing, freshSessions[sessionId]),
    }

    if (failure) {
      return {
        ...seeded,
        processStatus: 'failed',
        processError: failure,
        recoveryFailureCode: failureCode ?? 'start-failed',
        inputReady: false,
        inputReadinessReason: null,
        inputReadinessChangedAt: Date.now(),
      }
    }
    if (backend && !preserveObservedTerminalProcess) {
      return {
        ...seeded,
        processStatus: backend.lifecycle === 'live' ? 'started' : 'spawning',
        processError: null,
        recoveryFailureCode: null,
        exited: null,
        ...(snapshotIsAuthoritative
          ? {
              inputReady: backend.input.ready,
              inputReadinessRevision: backend.input.revision,
              // WHY the reason and clock are seeded on cold restore: main's
              // setInputReadiness dedupes, so a backend already sitting in a
              // non-ready state emits no further event after restore. Without
              // this, a pane that comes back wedged shows a generic "starting
              // agent" with no elapsed time — exactly the case the readout was
              // built for. Date.now() is honest here: the renderer genuinely
              // has not observed this state for any longer than it has existed.
              inputReadinessReason: backend.input.reason ?? null,
              inputReadinessChangedAt: Date.now(),
            }
          : {}),
      }
    }
    if (visibleProcess) {
      // WHY a pending pane is visible and explicitly "spawning": the durable
      // workspace shell should paint before any provider promise settles. An
      // already-observed live/failed/exited event is stronger than this seed,
      // so only a genuinely idle runtime is promoted to the pending state.
      return {
        ...seeded,
        processStatus: existing && existing.processStatus !== 'idle'
          ? existing.processStatus
          : 'spawning',
        recoveryFailureCode: existing?.recoveryFailureCode ?? null,
      }
    }

    // Hibernated sessions retain metadata/history but intentionally have no
    // backend until an explicit wake. Calling them started made the first
    // prompt after restart disappear into an absent PTY.
    return {
      ...seeded,
      processStatus: 'idle',
      processError: null,
      recoveryFailureCode: null,
      inputReady: false,
    }
  }

  const commitRehydratedState = (changedSessionId?: SessionId): boolean => {
    const newTabs = buildRemappedTabs()
    if (newTabs.length === 0) return false

    const restoredTileTabs = buildRemappedTileTabs(newTabs)
    if (!initialWorkspacePublished) {
      initialWorkspacePublished = true
      const initialSessions = buildRemappedSessions()
      for (const [sessionId, meta] of Object.entries(initialSessions)) {
        publishedSessionBaselines.set(sessionId, meta)
      }
      setState(prev => {
        const currentActiveTabStillExists = newTabs.some(t => t.id === prev.activeTabId)
        const activeTabId = currentActiveTabStillExists
          ? prev.activeTabId
          : restoredTileTabs?.focusedTabId
            ?? newTabs.find(t => t.id === persisted.activeTabId)?.id
            ?? newTabs[0].id
        const remappedDispatchMode = keepTiledLaneSessions(
          remapTiledLanes(
            persisted.dispatchMode
              ? {
                  ...persisted.dispatchMode,
                  focusedSessionId: persisted.dispatchMode.focusedSessionId
                    ? idMap.get(persisted.dispatchMode.focusedSessionId)
                    : undefined,
                }
              : null,
            idMap,
          ),
          // WHY remapping alone cannot repair stale lane ownership:
          // remapTiledLanes intentionally leaves unknown ids untouched because
          // valid hibernated sessions keep their durable ids. After ownership
          // normalization, initialSessions is the authority that distinguishes
          // those valid parked ids from deleted-tab ghosts. Closing every
          // Dispatch pointer over this same set prevents the repaired owner
          // record from lingering as a selected-but-unresolvable lane.
          new Set(Object.keys(initialSessions)),
        ) ?? null
        return {
          tabs: newTabs,
          activeTabId,
          dispatchMode: remappedDispatchMode,
          sessions: initialSessions,
          detachedSessions: buildRemappedDetachedSessions(),
          buried: buildRemappedBuried(),
          pinnedSessionIds: buildRemappedPinnedSessionIds(),
        }
      })
      setTileTabs(restoredTileTabs)
      setRuntimes(prev => {
        const out: Record<SessionId, SessionRuntime> = {}
        for (const sessionId of Object.keys(freshSessions)) {
          out[sessionId] = buildRecoveredRuntime(sessionId, prev[sessionId])
        }
        return out
      })
      return true
    }

    if (!changedSessionId) return true

    // WHY later outcomes are field-level reconciliation, never persisted-state
    // replay: once the shell is visible, the user may close a pane, type a
    // draft, change focus, create tabs, or receive feed events while another
    // provider is still starting. A slow outcome owns only its session's
    // backend fact. Rebuilding tabs/runtimes from workspace.json would
    // resurrect closed panes and erase newer renderer state.
    const remappedSessions = buildRemappedSessions()
    setState(prev => {
      if (!prev.sessions[changedSessionId] || !remappedSessions[changedSessionId]) return prev
      const currentMeta = prev.sessions[changedSessionId]
      const baselineMeta = publishedSessionBaselines.get(changedSessionId)
      const projectedMeta = remappedSessions[changedSessionId]
      const reconciledMeta = { ...projectedMeta } as Record<string, unknown>
      if (baselineMeta) {
        const currentRecord = currentMeta as Record<string, unknown>
        const baselineRecord = baselineMeta as Record<string, unknown>
        for (const key of new Set([
          ...Object.keys(baselineRecord),
          ...Object.keys(currentRecord),
        ])) {
          if (Object.is(currentRecord[key], baselineRecord[key])) continue
          if (Object.prototype.hasOwnProperty.call(currentRecord, key)) {
            reconciledMeta[key] = currentRecord[key]
          } else {
            delete reconciledMeta[key]
          }
        }
      }
      return {
        ...prev,
        sessions: {
          ...prev.sessions,
          [changedSessionId]: reconciledMeta as SessionMeta,
        },
      }
    })
    setRuntimes(prev => {
      const existing = prev[changedSessionId]
      if (!existing) return prev
      return {
        ...prev,
        [changedSessionId]: buildRecoveredRuntime(changedSessionId, existing),
      }
    })
    return true
  }

  // Publish every durable leaf before starting provider work. This is the
  // renderer-side half of bounded recovery: a hung provider remains a visible,
  // closable "starting" pane instead of withholding the entire workspace.
  const publishedDurableWorkspace = commitRehydratedState()

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
              code: 'start-failed',
            })
            syncRecoveryProjection()
            // eslint-disable-next-line no-console
            console.error(
              `[workspace] session ${oldId} has unknown provider kind ` +
              `${JSON.stringify(meta.kind)} — preserving metadata, not spawning. ` +
              `Was this workspace written by a newer Agent Code version?`,
            )
            commitRehydratedState(oldId)
            restoreSpan.end({ skipped: 'unknown-provider-kind' })
            return
          }
          const kind: SessionKind = meta.kind ?? DEFAULT_PROVIDER
          const builtInMcpDomains =
            isAgentProviderKind(kind)
              ? resolveSessionBuiltInMcpDomains({
                  provider: kind,
                  sessionDomains: meta.builtInMcpDomains,
                  defaultDomains: refs.defaultBuiltInMcpDomainsRef.current,
                })
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
          const resumeSessionId = isAgentSessionKind(kind) ? resumableProviderSessionId(meta) : undefined
          const restoredMeta = withoutProvisionalProviderSession(meta)
          const recovery = await recoverSessionBeforeDeadline(recoveryApi, {
            sessionId: oldId,
            kind,
            cwd: meta.cwd,
            resumeSessionId,
            dangerousMode: isAgentSessionKind(kind) ? refs.dangerousAgentsRef.current : undefined,
            useProxy: isAgentSessionKind(kind) ? refs.useProxyStreamingRef.current : undefined,
            recoverTmuxName: kind === 'terminal' ? meta.tmuxName : undefined,
            builtInMcpDomains,
            // Only bootstrap can prove the predecessor ID still came from the
            // durable workspace. Ordinary retry/wake calls must not be able to
            // abort a same-pane replacement transaction.
            reclaimPendingReplacement: true,
          }, recoveryTimeoutMs)
          const newId = oldId
          if (!recovery.ok) {
            recoveryOutcomes.set(newId, {
              status: 'failed',
              meta: {
                ...restoredMeta,
                ...(builtInMcpDomains !== undefined ? { builtInMcpDomains } : {}),
              },
              message: recovery.message,
              code: recovery.code,
            })
            syncRecoveryProjection()
            commitRehydratedState(newId)
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
              code: 'start-failed',
            })
            syncRecoveryProjection()
            commitRehydratedState(newId)
            restoreSpan.end({ outcome: 'identity-mismatch' })
            return
          }
          // Carry the full meta forward — kind + providerSessionId +
          // tmuxName — so the next save cycle doesn't drop these and
          // cause the session to degrade on the NEXT reload.
          // tmuxName is replaced with whatever main reported
          // (recovered name when alive, fresh name when respawned).
          const recoveredBuiltInMcpDomains =
            isAgentProviderKind(kind)
              ? resolveSessionBuiltInMcpDomains({
                  provider: kind,
                  // WHY successful recovery uses main's effective scope:
                  // an adopted provider keeps the MCP token it launched with.
                  // Persisting today's requested defaults instead would make
                  // renderer state claim tools are on/off without changing the
                  // already-running model process. Older responses fall back
                  // to the request so recovery remains tolerant at this seam.
                  sessionDomains:
                    recovery.snapshot.builtInMcpDomains ?? builtInMcpDomains,
                  defaultDomains: [],
                })
              : undefined
          const recoveredMeta: SessionMeta = {
            ...restoredMeta,
            ...(recoveredBuiltInMcpDomains !== undefined
              ? { builtInMcpDomains: recoveredBuiltInMcpDomains }
              : {}),
            ...(recovery.tmuxName ? { tmuxName: recovery.tmuxName } : {}),
          }
          recoveryOutcomes.set(newId, {
            status: 'live',
            meta: recoveredMeta,
            snapshot: recovery.snapshot,
          })
          syncRecoveryProjection()
          commitRehydratedState(newId)
          if (
            isAgentSessionKind(kind) &&
            resumeSessionId &&
            refs.stateRef.current.sessions[newId] &&
            refs.latestRuntimesRef.current[newId]
          ) {
            // WHY membership is re-checked after recovery: the user can close
            // a pane while its provider is starting. The history loader used
            // to accept the metadata override and recreate an empty runtime
            // after the close, leaving an invisible orphan in memory.
            void loadInitialHistoryForSession({
              sessionId: newId,
              meta: recoveredMeta,
              refs,
              setRuntimes,
            })
          }
          restoreSpan.end({ newId })
        } catch (err) {
          restoreSpan.end({ outcome: 'unexpected-error' })
          // Unexpected IPC/transport failures are still a resolved renderer
          // outcome. Keeping the local id, metadata, and draft makes retry
          // possible and prevents autosave from erasing the user's pane.
          recoveryOutcomes.set(oldId, {
            status: 'failed',
            meta,
            // WHY transport/provider exceptions do not cross into renderer
            // content: they can embed command lines, environment values, or
            // scoped MCP URLs. Detailed diagnostics stay in main; the pane
            // receives a stable operational message and typed retry state.
            message: 'Backend recovery failed unexpectedly. Retry this pane.',
            code: 'start-failed',
          })
          syncRecoveryProjection()
          commitRehydratedState(oldId)
          // WHY no raw exception logging here: transport errors can embed
          // commands, environment values, and scoped MCP URLs. Main owns the
          // detailed diagnostics; renderer records only the fixed outcome.
        }
      }),
  )

  if (!publishedDurableWorkspace) {
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
  // `ok` is the load-bearing field: restore is "complete" when every visible
  // leaf received an OUTCOME, including a retained failure — not when every
  // provider started. A run whose rehydrate.start has no matching complete is a
  // restore that never resolved, which pins autosave off and is invisible today
  // apart from a console.warn.
  //
  // WHY the unresolved ids are named and not just counted: a real workspace sat
  // at `expectedCount 4, resolvedCount 3, ok false` on every launch for three
  // weeks, and the journal could not say WHICH pane was missing. Diagnosing it
  // required diffing tile leaves against the `sessions` map by hand. The count
  // alone tells you that restore is stuck; the ids tell you why, which is the
  // whole point of recording this event.
  const unresolved = [...liveProcessIds].filter(id => !resolvedIds.has(id))
  reportLifecycle('rehydrate.complete', undefined, {
    expectedCount: expectedSessions,
    resolvedCount: resolvedIds.size,
    ok: resolvedIds.size === expectedSessions,
    // Only on a failure: a healthy boot would otherwise record an empty string
    // on every launch, and "the field is absent" already means "none".
    //
    // Capped at 8 because the journal sanitizer truncates strings over 300
    // chars, which at ~37 bytes per comma-joined UUID would slice the last id
    // in half — a half-id in a diagnostic is worse than a missing one, since
    // it reads like a real id. `expectedCount`/`resolvedCount` still carry the
    // true totals.
    ...(unresolved.length > 0
      ? { unresolvedSessionIds: unresolved.slice(0, 8).join(',') }
      : {}),
    durationMs: Date.now() - rehydrateStartedAt,
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
