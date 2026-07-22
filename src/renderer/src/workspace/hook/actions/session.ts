import {
  DEFAULT_PROVIDER,
  isAgentProviderKind,
  isSessionKind,
} from '@shared/types/providerKind'
import type { SessionRecoverFailureCode } from '@shared/types/session'
import { useCallback, useRef } from 'react'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { clearLiveEntryWindowSession } from '@renderer/session-runtime/liveEntryWindow'
import type { SessionId, SessionKind, SessionMeta, TileNode } from '@renderer/workspace/types'
import type { BuiltInMcpDomain } from '@mcp/shared/types'
import { normalizeSessionBuiltInMcpDomains } from '@renderer/workspace/mcpDomains'
import {
  clearTiledLaneSessions,
  remapTiledLanes,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'
import {
  remapGridRelatedSelections,
  remapPinnedSessionIds,
  remapSessionsRelationships,
} from '@renderer/workspace/idRemap'
import { closeLeaf, collectLeaves, remapTileTreeSessionIds } from '@renderer/workspace/tile-tree/treeOps'
import type { Tab } from '@renderer/workspace/types'
import { sessionSpawnErrorMessage } from '@renderer/workspace/spawn/errorMessage'
import {
  ghostsToPersist,
  reconcileUpstream,
} from '@renderer/session-runtime/ghosts'
import { reduceGhostLogSansSuperseded as reduceGhostLog } from 'agent-transcript-parser/ghost'

import type {
  WorkspaceSetRuntimes,
  WorkspaceSetState,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import { loadInitialHistoryForSession } from '@renderer/workspace/hook/actions/initialHistory'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import {
  hasDurableProviderSession,
  resumableProviderSessionId,
  seedResumedRuntimeFields,
  withoutProvisionalProviderSession,
} from '@renderer/workspace/providerSessionIdentity'
import {
  collectLiveProcessIds,
  collectOwnedSessionIds,
  collectUnownedSessionIds,
  pickOwnedSessions,
} from '@renderer/workspace/sessionOwnership'

// -----------------------------------------------------------------------------
// Session lifecycle actions.
//
// spawn              — main process call to create a new session. Returns the
//                      new sessionId. Updates state.sessions + runtimes
//                      synchronously. Schedules ghost-log bootstrap via
//                      setTimeout(0) so the fresh runtime lands first.
// killSession        — main process call to kill a session. Cleans up
//                      runtime, state.sessions, and per-session refs.
// replaceSession     — kill current focused session + spawn a new one in
//                      the same tile-tree slot. Used by resume picker and
//                      provider switch.
// reloadAgentSessions — recreate every Claude/Codex session with fresh
//                       dangerous-mode settings. Remaps panes + buried
//                       records onto the new ids.
// -----------------------------------------------------------------------------

export type SessionActions = {
  spawn: (
    cwd: string,
    opts?: {
      resumeSessionId?: string
      kind?: SessionKind
      dangerousMode?: boolean
      recoverTmuxName?: string
      builtInMcpDomains?: BuiltInMcpDomain[]
    },
  ) => Promise<SessionId>
  ensureSessionLive: (sessionId: SessionId) => Promise<SessionId>
  killSession: (sessionId: SessionId) => Promise<void>
  replaceSession: (
    cwd: string,
    opts?: {
      resumeSessionId?: string
      kind?: SessionKind
      builtInMcpDomains?: BuiltInMcpDomain[]
      targetSessionId?: SessionId
    },
  ) => Promise<SessionId | undefined>
  reloadAgentSessions: (dangerousMode?: boolean) => Promise<void>
  softReloadAgentView: (sessionId?: SessionId) => Promise<SessionId | null>
}

export async function killSessionBackendIfOwned(
  refs: WorkspaceRefs,
  sessionId: SessionId,
): Promise<boolean> {
  const meta = refs.stateRef.current.sessions[sessionId]
  if (!meta) return false
  // WHY this proof lives in main as one atomic check+kill: renderer runtime
  // flags are advisory and can be reset by retry, soft reload, or a delayed
  // feed event. A stale pane may share its id with another project, but only a
  // matching provider kind and lexical cwd authorize destructive teardown.
  return await window.api.killOwnedSession({
    sessionId,
    kind: meta.kind,
    cwd: meta.cwd,
  })
}

function softReloadRuntime(current: SessionRuntime, hasProviderSession: boolean): SessionRuntime {
  if (!hasProviderSession) {
    // WHY no-provider soft reload is non-destructive:
    //
    // Soft reload used to mean "discard renderer-derived state, then replay the
    // committed transcript from disk." That only works when a providerSessionId
    // points at a transcript we can load. In the #290 failure mode Claude is
    // still alive through proxy/semantic/screen, but the committed JSONL is
    // missing and the pane may have no provider id yet. Resetting entries,
    // ghosts, and semantic state in that condition erases the only visible
    // progress and then labels the empty pane "ready." Preserve the live-only
    // state and make the durability problem explicit instead.
    return {
      ...current,
      scrollToLatestRequest: current.scrollToLatestRequest + 1,
      hasOlderHistory: false,
      transcriptStatus: 'disconnected',
      transcriptError:
        'Cannot soft reload this agent view because no committed provider transcript is known yet.',
    }
  }

  const reset = emptyRuntime()

  // WHY this is a selective reset instead of a fresh `emptyRuntime()`:
  //
  // Soft reload is meant for "the renderer/feed got weird while the
  // backend is still working". A hard reload can throw the process
  // away and resume from disk, but this action must leave the live
  // provider process alone. That means process lifecycle, input
  // readiness, in-progress phase text, draft text/images, and tail
  // preference are still authoritative and must survive. The things
  // we discard are renderer-derived caches: visible entries, semantic
  // ghosts, screen snapshots, indexes, pickers, and transient prompts.
  //
  // The history loader runs immediately after this reset when a
  // providerSessionId exists. It rebuilds committed transcript rows
  // and worktree context from disk, while any IPC events that arrive
  // during the load merge into this same runtime. Resetting UUID
  // de-dupe state in the caller is the other half of that contract;
  // without it, replay would think every old row was already visible.
  return {
    ...reset,
    draftInput: current.draftInput,
    draftImages: current.draftImages,
    tailMode: current.tailMode,
    scrollToLatestRequest: current.scrollToLatestRequest + 1,
    processActive: current.processActive,
    sessionStatus: current.sessionStatus,
    sessionStatusSource: current.sessionStatusSource,
    processStatus: current.processStatus,
    processError: current.processError,
    recoveryFailureCode: current.recoveryFailureCode,
    inputReady: current.inputReady,
    inputReadinessRevision: current.inputReadinessRevision,
    exited: current.exited,
    projectDir: current.projectDir,
    conditions: current.conditions,
    activityStatus: current.activityStatus,
    unreadSince: current.unreadSince,
    unreadKind: current.unreadKind,
    streamPhase: current.streamPhase,
    streamPhasePendingToolName: current.streamPhasePendingToolName,
    streamPhasePendingToolUseId: current.streamPhasePendingToolUseId,
    turnStartedAt: current.turnStartedAt,
    phaseChangedAt: current.phaseChangedAt,
    submittedAt: current.submittedAt,
    hasOlderHistory: true,
    transcriptStatus: 'loading',
    transcriptError: null,
  }
}

function waitForSessionInputReady(
  refs: WorkspaceRefs,
  sessionId: SessionId,
  timeoutMs = 30_000,
): Promise<void> {
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    const tick = () => {
      const runtime = refs.latestRuntimesRef.current[sessionId]
      if (
        runtime &&
        runtime.inputReady &&
        runtime.processStatus === 'started' &&
        runtime.exited === null
      ) {
        resolve()
        return
      }
      if (runtime?.processStatus === 'failed') {
        reject(new Error(runtime.processError ?? 'Agent failed to start'))
        return
      }
      if (runtime?.exited !== null && runtime?.exited !== undefined) {
        reject(new Error('Agent exited before it became ready for input'))
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('Timed out waiting for agent to become ready for input'))
        return
      }
      window.setTimeout(tick, 50)
    }
    tick()
  })
}

export function useSessionActions(
  state: { activeTabId: string; sessions: Record<SessionId, SessionMeta>; tabs: Tab[] },
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  refs: WorkspaceRefs,
): SessionActions {
  const wakeInFlightRef = useRef(new Map<SessionId, Promise<SessionId>>())

  // spawn — wrapped so callers don't have to touch window.api
  // directly. Updates state.sessions synchronously after main
  // responds with an id.
  //
  // `resumeSessionId` (optional) triggers a resume: main spawns
  // claude with `--resume <uuid>` and tails the existing session
  // file, so the renderer receives the full session history as
  // jsonl-entry events immediately after started. Our own sessionId
  // is still fresh — it's a workspace-scoped identifier for routing,
  // distinct from CC's session UUID.
  const spawn = useCallback(
    async (
      cwd: string,
      opts?: {
        resumeSessionId?: string
        kind?: SessionKind
        dangerousMode?: boolean
        recoverTmuxName?: string
        builtInMcpDomains?: BuiltInMcpDomain[]
      },
    ): Promise<SessionId> => {
      const kind: SessionKind = opts?.kind ?? DEFAULT_PROVIDER
      const dangerousMode =
        opts?.dangerousMode ??
        (kind !== 'terminal' ? refs.dangerousAgentsRef.current : undefined)
      // Agent providers both accept `useProxy`; terminals ignore it.
      // Claude uses MITM proxy streaming, Codex uses a local Responses
      // proxy via `openai_base_url`.
      const useProxy =
        kind !== 'terminal' ? refs.useProxyStreamingRef.current : undefined
      const builtInMcpDomains =
        kind !== 'terminal'
          ? normalizeSessionBuiltInMcpDomains(opts?.builtInMcpDomains)
          : undefined
      let sessionId: SessionId
      let tmuxName: string | undefined
      try {
        const result = await window.api.spawnSession({
          kind,
          cwd,
          resumeSessionId: opts?.resumeSessionId,
          dangerousMode,
          useProxy,
          recoverTmuxName: opts?.recoverTmuxName,
          builtInMcpDomains,
        })
        sessionId = result.sessionId
        tmuxName = result.tmuxName
      } catch (err) {
        throw new Error(sessionSpawnErrorMessage(kind, err, useProxy === true))
      }
      const previousMeta = refs.stateRef.current.sessions[sessionId]
      const meta: SessionMeta = {
        ...(previousMeta ?? {}),
        cwd,
        kind,
        ...(tmuxName ? { tmuxName } : {}),
        ...(kind !== 'terminal' && opts?.resumeSessionId
          ? {
              providerSessionId: opts.resumeSessionId,
              providerSessionIdSource: 'resume-request' as const,
            }
          : {}),
        ...(kind !== 'terminal' && builtInMcpDomains
          ? { builtInMcpDomains }
          : {}),
      }
      setState(prev => ({
        ...prev,
        sessions: {
          ...prev.sessions,
          // Persist tmuxName when main returns one — that's the
          // signal that this terminal got tmux backing and is
          // eligible for cross-restart recovery on next launch.
          [sessionId]: meta,
        },
      }))
      setRuntimes(prev => {
        const current = prev[sessionId]
        const base = emptyRuntime()
        return {
          ...prev,
          [sessionId]: {
            ...base,
            ...(kind !== 'terminal'
              ? seedResumedRuntimeFields(current, meta)
              : {
                  hasOlderHistory: false,
                  transcriptStatus: 'ready' as const,
                  transcriptError: null,
                  processStatus: 'started' as const,
                  processError: null,
                  inputReady: current?.inputReady ?? false,
                  inputReadinessRevision: current?.inputReadinessRevision ?? -1,
                }),
            exited: current?.exited ?? null,
          },
        }
      })
      if (kind !== 'terminal' && meta.providerSessionId) {
        void loadInitialHistoryForSession({
          sessionId,
          meta,
          refs,
          setRuntimes,
        })
      }

      // Ghost log bootstrap — fire-and-forget, no await. If a prior
      // run of Agent Code persisted ghosts for this sessionId, replay
      // them through the atp reducer and merge into the runtime's
      // ghost map. The renderer then sees the same merged feed after
      // reload as it saw before. A missing file is not an error.
      //
      // WHY behind a setTimeout 0: spawnSession above set the fresh
      // runtime via setRuntimes(prev => ...) — that update is queued
      // and will land on the next tick. Reading the ghost log and
      // applying it synchronously would run against the PREVIOUS
      // runtime snapshot and its setRuntimes would clobber the
      // fresh empty runtime. Deferring by one tick lets the empty
      // runtime land first, then the bootstrap merge runs on top.
      setTimeout(() => {
        void window.api
          .ghostRead(sessionId)
          .then(rawEntries => {
            if (!rawEntries || rawEntries.length === 0) return
            const bootstrapped = reduceGhostLog(rawEntries as never[])
            if (bootstrapped.size === 0) return
            setRuntimes(prev => {
              const current = prev[sessionId]
              if (!current) return prev
              // Merge — disk ghosts only fill slots the runtime
              // hasn't already produced in this session. If a ghost
              // for the same uuid exists in-memory (rare; would mean
              // a live event beat the bootstrap read), prefer the
              // in-memory one because it's strictly fresher.
              let merged = new Map(current.ghosts)
              for (const [uuid, ghost] of bootstrapped) {
                if (!merged.has(uuid)) merged.set(uuid, ghost)
              }
              // Reconcile against whatever JSONL entries already
              // landed during the initial bootstrap burst. Without
              // this, ghosts for turns that already have committed
              // entries in `current.entries` would stay
              // un-superseded forever: the live JSONL ingest already
              // ran `reconcileUpstream` against the PREVIOUS (empty)
              // ghost map and found no matches; now that the real
              // ghosts are landing, nothing re-checks the
              // already-ingested entries. This pass fixes the
              // "crashed mid-turn, resumed with an orphan ghost that
              // actually got committed" case. See Task 7 of the
              // 2026-04-20 rendering-fixes plan.
              for (const entry of current.entries) {
                merged = reconcileUpstream(entry, merged)
              }
              // Persist any supersedes we just produced so the next
              // resume reads the ghosts already in their reconciled
              // state. `ghostsToPersist` diffs by updatedAt so it
              // only emits ghosts whose state actually changed in
              // this pass.
              for (const ghost of ghostsToPersist(current.ghosts, merged)) {
                window.api.ghostAppend(sessionId, ghost)
              }
              return {
                ...prev,
                [sessionId]: { ...current, ghosts: merged },
              }
            })
          })
          .catch(err => {
            // Ghost bootstrap failures are non-fatal — the session
            // still works, we just lose crash-recovered provisional
            // state. Log and move on.
            console.warn('[ghost] bootstrap read failed:', err)
          })
      }, 0)

      return sessionId
    },
    [refs.dangerousAgentsRef, refs.useProxyStreamingRef, setRuntimes, setState],
  )

  const ensureSessionLive = useCallback(
    async (sessionId: SessionId): Promise<SessionId> => {
      const inFlight = wakeInFlightRef.current.get(sessionId)
      if (inFlight) return await inFlight

      const wake = (async (): Promise<SessionId> => {
        const snapshot = refs.stateRef.current
        const meta = snapshot.sessions[sessionId]
        if (!meta) {
          throw new Error(`Cannot wake ${sessionId}; no persisted session metadata exists.`)
        }
        if (meta.kind !== undefined && !isSessionKind(meta.kind)) {
          const message = 'This pane uses an unsupported provider. Update Agent Code or close it.'
          setRuntimes(prev => {
            const current = prev[sessionId]
            if (!current) return prev
            return {
              ...prev,
              [sessionId]: {
                ...current,
                processStatus: 'failed',
                processError: message,
                recoveryFailureCode: 'start-failed',
                inputReady: false,
              },
            }
          })
          throw new Error(message)
        }
        const kind: SessionKind = meta.kind ?? DEFAULT_PROVIDER

        const builtInMcpDomains =
          kind !== 'terminal' ? normalizeSessionBuiltInMcpDomains(meta.builtInMcpDomains) : undefined
        const resumeSessionId = kind !== 'terminal' ? resumableProviderSessionId(meta) : undefined
        const restoredMeta = withoutProvisionalProviderSession(meta)
        const priorRecoveryFailureCode =
          refs.latestRuntimesRef.current[sessionId]?.recoveryFailureCode ?? null

        setRuntimes(prev => {
          const current = prev[sessionId]
          if (!current) return prev
          return {
            ...prev,
            [sessionId]: {
              ...current,
              processStatus: 'spawning',
              processError: null,
              // WHY an ownership-conflict fence survives the retry RPC: feed
              // events and close actions can race while main decides whether
              // this pane may adopt the id. Only a successful matching
              // snapshot proves the unrelated-backend quarantine can clear.
              recoveryFailureCode: current.recoveryFailureCode,
              exited: null,
            },
          }
        })

        // WHY this recovers under the SAME SessionId instead of using
        // replaceSession/idMap or renderer get-kind-then-spawn:
        //
        // This action repairs a split-brain state created by process restart:
        // renderer workspace metadata survived, but main's provider registry did
        // not. The renderer id is already referenced by Dispatch rows, buried
        // records, tiled lanes, pins, grid-related selections, orchestration MCP
        // ownership, and possibly a tool call that is currently trying to send
        // to that exact id. A new id would force a broad remap while a command is
        // in flight. Reusing the id makes wake equivalent to "main caught up with
        // workspace.json" and keeps every existing reference valid. The main
        // recovery claim is the ownership lock: renderer single-flight only
        // suppresses duplicate UI transitions and is never relied on for
        // provider, proxy, or MCP exactly-once behavior.
        let readyError: unknown = null
        let recoveryFailureCode: SessionRecoverFailureCode | null = null
        let ownershipProven = false
        let recoverySnapshot: Awaited<ReturnType<typeof window.api.getBackendSnapshot>> = null
        let recoveredTmuxName: string | undefined
        // Did THIS call start the process, or did it adopt one that was
        // already running? The distinction decides whether the readiness
        // wait below is meaningful and whether the kill on its timeout is
        // legitimate. Main already answers it; this used to be discarded.
        let recoveryDisposition: 'adopted' | 'spawned' | null = null
        try {
          const recovery = await window.api.recoverSession({
            sessionId,
            kind,
            cwd: meta.cwd,
            resumeSessionId,
            builtInMcpDomains,
            recoverTmuxName: kind === 'terminal' ? meta.tmuxName : undefined,
            dangerousMode: kind !== 'terminal' ? refs.dangerousAgentsRef.current : undefined,
            useProxy: kind !== 'terminal' ? refs.useProxyStreamingRef.current : undefined,
          })
          if (!recovery.ok) {
            readyError = new Error(recovery.message)
            recoveryFailureCode = priorRecoveryFailureCode === 'ownership-conflict'
              ? 'ownership-conflict'
              : recovery.code
          } else {
            ownershipProven = true
            recoverySnapshot = recovery.snapshot
            recoveredTmuxName = recovery.tmuxName
            recoveryDisposition = recovery.disposition
            setRuntimes(prev => {
              const current = prev[sessionId]
              if (!current) return prev
              // Any failed/exited state observed AFTER the wake transition to
              // spawning is a real provider event and outranks the returned
              // snapshot. The stale failure that initiated retry was cleared
              // above, so a successful retry is not trapped in "failed".
              const preserveObservedTerminalProcess = current.processStatus === 'failed' ||
                current.processStatus === 'exited'
              const snapshotIsAuthoritative = recovery.snapshot.input.revision >=
                current.inputReadinessRevision
              return {
                ...prev,
                [sessionId]: {
                  ...current,
                  ...(preserveObservedTerminalProcess
                    ? {}
                    : {
                        processStatus: recovery.snapshot.lifecycle === 'live'
                          ? 'started' as const
                          : 'spawning' as const,
                        processError: null,
                        recoveryFailureCode: null,
                        ...(snapshotIsAuthoritative
                          ? {
                              inputReady: recovery.snapshot.input.ready,
                              inputReadinessRevision: recovery.snapshot.input.revision,
                            }
                          : {}),
                        exited: null,
                      }),
                },
              }
            })
          }
        } catch {
          // WHY unexpected IPC errors use a fixed message: rejected invokes
          // can contain provider commands, environment fragments, or scoped
          // MCP URLs. Typed recovery results carry the safe operational detail;
          // transport failures never become pane content or toast text.
          readyError = new Error('Backend recovery failed unexpectedly. Retry this pane.')
          recoveryFailureCode = priorRecoveryFailureCode
        }

        // An ADOPTED live backend is already up. Waiting on its input
        // readiness is not just pointless, it is actively destructive.
        //
        // `input.ready` is false for a healthy Claude agent whenever a
        // provider condition is on screen OR the raw composer holds any
        // text (`derivePromptGateState`, claudeSession.ts). In terminal
        // mode the user types straight into the TUI and answers permission
        // prompts there, so "draft present" is the NORMAL state.
        //
        // Note what the problem was NOT: readiness does get re-published.
        // `publishPromptGate` emits on every transition into ready and
        // `setInputReadiness` only dedupes unchanged values, so clearing the
        // draft or answering the prompt unblocks the poll. The timeout was
        // guaranteed for one reason only — the pane the user would have used
        // to do either was BLANK, because AgentTerminalLeaf chained its
        // attach behind this wake. (That chaining is gone now; the attach
        // happens first.) Recording this because the edge-trigger theory is
        // the tempting one and it sends you to the wrong file.
        //
        // Either way the wait is meaningless for a backend that was already
        // running before this call, and it ended in
        // killSessionBackendIfOwned() below. That is issue #596: opening
        // Spotlight, or switching tabs, killed a live, busy, perfectly
        // healthy agent 30 seconds later.
        //
        // The `lifecycle === 'live'` conjunct is redundant today — `adopted`
        // is only returned when a RegistryEntry already existed, which is
        // exactly what makes the snapshot 'live'. It is kept so the skip
        // stays anchored to observed liveness rather than to a disposition
        // label a future recover() might widen.
        const adoptedLiveBackend =
          recoveryDisposition === 'adopted' && recoverySnapshot?.lifecycle === 'live'
        if (!readyError && recoverySnapshot && !recoverySnapshot.input.ready && !adoptedLiveBackend) {
          try {
            await waitForSessionInputReady(refs, sessionId)
          } catch (err) {
            readyError = err
            // A provider that started but never reached its real composer
            // boundary must be replaced, not repeatedly re-adopted on Retry.
            // Main rechecks kind+cwd atomically, so a stale/conflicted pane
            // cannot use this timeout to stop another workspace's backend.
            //
            // SPAWNED ONLY. That reasoning (from #548) is about a process
            // THIS call just started which never came up. Applied to an
            // adopted backend it means "this agent is busy, so destroy it",
            // and the kind+cwd ownership proof cannot catch that — it is
            // the same entry we successfully adopted moments ago, so the
            // proof passes trivially. The guard above already skips the
            // wait for adopted+live; this second check is deliberate belt
            // and braces, so a future caller that reaches the wait some
            // other way still cannot turn a timeout into a kill.
            //
            // ACCEPTED COST, stated plainly: `lifecycle: 'live'` means a
            // RegistryEntry exists, not that the process is healthy — and
            // `sessions.set()` runs before `await session.start()`. So a
            // provider that registers and then wedges before its composer
            // (hung MCP handshake, say) is now adopted and skipped rather
            // than killed. Before this change the 30s timeout would have
            // killed it and marked the pane `failed`, which is what surfaces
            // the Retry button; now it sits at `started` + not-ready with no
            // in-app retry short of closing the pane. That trade is
            // deliberate — wrongly killing a busy healthy agent is far more
            // common and far worse than a stuck pane on a wedged one — but
            // it does mean #548's self-heal no longer covers this class, and
            // nothing has replaced it.
            if (recoveryDisposition === 'spawned') {
              void killSessionBackendIfOwned(refs, sessionId).catch(() => undefined)
            }
          }
        }

        if (readyError) {
          const message = readyError instanceof Error && readyError.message.length > 0
            ? readyError.message
            : `Could not wake session ${sessionId}`
          setRuntimes(prev => {
            const current = prev[sessionId]
            if (!current) return prev
            return {
              ...prev,
              [sessionId]: {
                ...current,
                processStatus: 'failed',
                processError: message,
                recoveryFailureCode: ownershipProven
                  ? 'start-failed'
                  : recoveryFailureCode ?? priorRecoveryFailureCode ?? 'start-failed',
                inputReady: false,
              },
            }
          })
          throw readyError
        }

        const recoveredMeta: SessionMeta = {
          ...restoredMeta,
          ...(builtInMcpDomains ? { builtInMcpDomains } : {}),
          ...(recoveredTmuxName ? { tmuxName: recoveredTmuxName } : {}),
        }
        setState(prev => {
          const current = prev.sessions[sessionId]
          if (!current) return prev
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [sessionId]: { ...current, ...recoveredMeta },
            },
          }
        })

        if (
          kind !== 'terminal' &&
          resumeSessionId &&
          refs.stateRef.current.sessions[sessionId] &&
          refs.latestRuntimesRef.current[sessionId]
        ) {
          // Parked/buried sessions do not hydrate history at app bootstrap.
          // Their explicit wake is therefore the first safe moment to rebuild
          // the durable feed, including legacy Claude metadata whose kind was
          // absent and defaulted above.
          void loadInitialHistoryForSession({
            sessionId,
            meta: recoveredMeta,
            refs,
            setRuntimes,
          })
        }

        return sessionId
      })()

      wakeInFlightRef.current.set(sessionId, wake)
      try {
        return await wake
      } finally {
        if (wakeInFlightRef.current.get(sessionId) === wake) {
          wakeInFlightRef.current.delete(sessionId)
        }
      }
    },
    [
      refs.dangerousAgentsRef,
      refs.stateRef,
      refs.useProxyStreamingRef,
      setRuntimes,
      setState,
    ],
  )

  const killSession = useCallback(
    async (sessionId: SessionId) => {
      await killSessionBackendIfOwned(refs, sessionId)
      setRuntimes(prev => {
        const next = { ...prev }
        delete next[sessionId]
        return next
      })
      setState(prev => {
        const nextSessions = { ...prev.sessions }
        delete nextSessions[sessionId]
        const detachedSessions = { ...prev.detachedSessions }
        delete detachedSessions[sessionId]
        // Clear the killed session out of any tiled lane FIRST (a lane can
        // hold a session that isn't the classic dispatch focus), then clear
        // the classic focus if it pointed here. Otherwise the lane dangles at
        // a dead id and the layout's auto-fill effect bounces it to tile 0.
        const clearedDispatch = clearTiledLaneSessions(prev.dispatchMode, sessionId)
        const dispatchMode =
          clearedDispatch?.focusedSessionId === sessionId
            ? { ...clearedDispatch, focusedSessionId: undefined }
            : clearedDispatch
        return {
          ...prev,
          sessions: nextSessions,
          detachedSessions,
          dispatchMode,
        }
      })
      delete refs.seenUuidsRef.current[sessionId]
      // Live-window bookkeeping follows the seen-uuid lifecycle (see
      // liveEntryWindow.ts: trimmed ⊆ ever-seen must hold).
      clearLiveEntryWindowSession(sessionId)
      delete refs.latestScreenRef.current[sessionId]
      // If a bootstrap debounce was in flight for this session,
      // cancel it — the session is gone; firing the deferred
      // bootstrapping→false flip later would be a no-op against a
      // missing runtime but it's cleaner to release the timer
      // immediately.
      const timer = refs.bootstrapTimersRef.current.get(sessionId)
      if (timer) {
        clearTimeout(timer)
        refs.bootstrapTimersRef.current.delete(sessionId)
      }
    },
    [refs.bootstrapTimersRef, refs.latestScreenRef, refs.seenUuidsRef, setRuntimes, setState],
  )

  // Kills the current session in the focused leaf and spawns a new
  // one in the same position. Used by the resume flow to swap a
  // session without changing the tile tree structure — the pane
  // stays where it is, only its backing session changes.
  const replaceSession = useCallback(
    async (
      cwd: string,
      opts?: {
        resumeSessionId?: string
        kind?: SessionKind
        builtInMcpDomains?: BuiltInMcpDomain[]
        targetSessionId?: SessionId
      },
    ): Promise<SessionId | undefined> => {
      const snapshot = refs.stateRef.current
      const { targetSessionId: _targetSessionId, ...spawnOpts } = opts ?? {}
      // WHY this reads Dispatch focus before tab focus:
      //
      // `replaceSession` powers resume, reload, provider-switch, and rewind.
      // Those commands target the thing the user is visibly commanding. In
      // Dispatch Mode that can be a detached row, or a grid row that did not
      // mutate Tab.focusedSessionId. Remapping by the old grid-only focus would
      // make the palette labels talk about one agent while the destructive
      // replacement happened to another.
      // WHY callers may pin the target:
      // Most command actions should follow the *current* command target at the
      // moment replacement begins. Rewind is different: main may spend time
      // cloning a provider transcript before the pane swap, and the user can
      // legitimately focus another pane during that await. Re-reading focus
      // after the clone would replace the wrong pane with the rewound provider
      // id. `targetSessionId` lets those two-phase operations say "replace the
      // pane I validated before the await" while preserving the default
      // Dispatch-aware targeting for simple one-shot commands.
      const oldId = _targetSessionId ?? commandTargetSessionIdForState(snapshot)
      if (!oldId) return
      const oldMeta = snapshot.sessions[oldId]
      if (!oldMeta) return
      const nextKind = spawnOpts.kind ?? oldMeta?.kind ?? DEFAULT_PROVIDER
      // WHY replaceSession inherits MCP domains by default:
      //
      // Reload, provider switch, resume, and rewind all funnel through this
      // path. Most callers think in terms of "keep this pane, replace the
      // provider process" and therefore do not know they must restate every
      // enabled MCP domain. Treating the old session metadata as the default
      // keeps MCP enablement a durable property of the agent pane instead of a
      // transient spawn flag that disappears on the next routine reload.
      const builtInMcpDomains =
        nextKind !== 'terminal'
          ? normalizeSessionBuiltInMcpDomains(
            spawnOpts.builtInMcpDomains ?? oldMeta?.builtInMcpDomains,
          )
          : undefined
      const oldDraft = refs.latestRuntimesRef.current[oldId]?.draftInput ?? ''
      const newId = await spawn(cwd, {
        ...spawnOpts,
        ...(builtInMcpDomains ? { builtInMcpDomains } : {}),
      })
      setRuntimes(prev => ({
        ...prev,
        [newId]: {
          ...(prev[newId] ?? emptyRuntime()),
          draftInput: oldDraft,
        },
      }))

      await killSessionBackendIfOwned(refs, oldId)
      setRuntimes(prev => {
        const next = { ...prev }
        delete next[oldId]
        return next
      })
      delete refs.seenUuidsRef.current[oldId]
      clearLiveEntryWindowSession(oldId)
      delete refs.latestScreenRef.current[oldId]

      // Swap the sessionId wherever this live session is placed. Grid sessions
      // live in one tile-tree leaf; detached Dispatch sessions live in
      // detachedSessions with no leaf at all.
      const idMap = new Map<SessionId, SessionId>([[oldId, newId]])

      setState(prev => {
        const sessions = { ...prev.sessions }
        delete sessions[oldId]
        // Persist the replacement provider metadata immediately
        // instead of waiting for the first transcript line to
        // round-trip back from main. That wait window is usually
        // short, but it is still a real race: a workspace save or
        // pane action that snapshots SessionMeta in that gap would
        // see "new session id, but no providerSessionId yet" and
        // could forget how to resume the pane on the next launch.
        //
        // Keeping the requested resumeSessionId here makes
        // replaceSession the single source of truth for "this pane
        // now points at provider X's persisted transcript Y",
        // whether the trigger was the resume picker or the new
        // switch-provider flow.
        sessions[newId] = {
          ...(sessions[newId] ?? { cwd, kind: nextKind }),
          cwd,
          kind: nextKind,
          ...(spawnOpts.resumeSessionId
            ? {
                providerSessionId: spawnOpts.resumeSessionId,
                providerSessionIdSource: 'resume-request' as const,
              }
            : {}),
          ...(builtInMcpDomains ? { builtInMcpDomains } : {}),
        }
        const detachedSessions = { ...prev.detachedSessions }
        const detached = detachedSessions[oldId]
        if (detached) {
          delete detachedSessions[oldId]
          detachedSessions[newId] = { ...detached, sessionId: newId }
        }
        return {
          ...prev,
          tabs: prev.tabs.map(t => {
            if (!collectLeaves(t.root).includes(oldId)) return t
            return {
              ...t,
              root: remapTileTreeSessionIds(t.root, idMap),
              focusedSessionId:
                t.focusedSessionId === oldId ? newId : t.focusedSessionId,
            }
          }),
          // Remap relationship pointers across ALL sessions: a linked /
          // orchestration CHILD of the swapped session carries oldId in its
          // linkedParentId/orchestrationParentId/orchestrationRootId, so the
          // swap has to update those too or the child renders top-level and
          // parent-scoped orchestration reads break. (rehydrate already does
          // this; reload/switch/resume/rewind funnel through here and didn't.)
          sessions: remapSessionsRelationships(sessions, idMap),
          // A pinned agent that gets a fresh id on reload/switch must follow
          // to the new id instead of silently dropping out of the Pinned list.
          pinnedSessionIds: remapPinnedSessionIds(prev.pinnedSessionIds, idMap),
          gridRelatedSelections: remapGridRelatedSelections(prev.gridRelatedSelections, idMap),
          detachedSessions,
          // Remap the swapped session id everywhere Dispatch holds it: the
          // classic single-view focus AND every Tiled Dispatch lane selection
          // (dispatchMode.tiled.lanes[].selectedSessionId). reload /
          // provider-switch / resume / rewind all funnel through here; before
          // this, the focused lane kept pointing at the now-dead oldId and the
          // layout's auto-fill effect re-homed it to the first tile. Same
          // tiled-vs-grid divergence as #266/#267/#271, fixed at the swap.
          dispatchMode: remapTiledLanes(
            prev.dispatchMode?.focusedSessionId === oldId
              ? { ...prev.dispatchMode, focusedSessionId: newId }
              : prev.dispatchMode,
            idMap,
          ),
        }
      })
      return newId
    },
    [
      refs.latestRuntimesRef,
      refs.latestScreenRef,
      refs.seenUuidsRef,
      refs.stateRef,
      setRuntimes,
      setState,
      spawn,
    ],
  )

  // Recreates every Claude/Codex session with the requested
  // dangerous mode, then remaps visible panes and buried records
  // onto the fresh session ids. Plain terminal sessions are left
  // untouched.
  const reloadAgentSessions = useCallback(
    async (dangerousMode = refs.dangerousAgentsRef.current) => {
      const current = refs.stateRef.current
      const liveProcessIds = collectLiveProcessIds(current)
      const staleIds = collectUnownedSessionIds(current)
      if (staleIds.length > 0) {
        // WHY reload prunes but does not kill unowned ids directly:
        //
        // `reloadAgentSessions` is a user-visible policy change ("restart the
        // owned agents with the current dangerous-mode setting"), not a
        // workspace garbage collector. If an unowned runtime process exists,
        // it has already escaped the UI ownership model; respawning it here is
        // the bug. Dropping the metadata prevents the stale row from surviving
        // the reload/autosave cycle, while process cleanup can stay best-effort
        // at the explicit kill/session-manager layer.
        // eslint-disable-next-line no-console
        console.warn('[workspace] dropping unowned sessions during agent reload:', staleIds)
      }
      // WHY filter by liveProcessIds, not ownedIds (mirrors the rehydrate fix):
      //
      // After the rehydrate live-vs-owned split, hibernated dispatch agents
      // (entries in `state.sessions` whose ids are NOT in any tile leaf) have
      // no PTY, no mitmdump, and no provider process to reload. Toggling
      // dangerous mode while parked agents exist used to call killSession +
      // spawnSession on every one of them, which re-introduced the original
      // fork-bomb in a different code path: a single mode toggle would
      // resurrect N hibernated agents as live processes. liveProcessIds
      // restricts the reload to tile-leaf sessions actually exposed to the
      // user; hibernated agents pick up the new dangerous-mode setting when
      // the wake-on-attach UI later spawns them.
      const agentEntries = Object.entries(current.sessions).filter(([id, meta]) => {
        if (!liveProcessIds.has(id)) return false
        const kind = meta.kind ?? DEFAULT_PROVIDER
        return isAgentProviderKind(kind)
      })
      if (agentEntries.length === 0) return

      const oldRuntimes = refs.latestRuntimesRef.current
      const idMap = new Map<SessionId, SessionId>()
      const failedIds = new Set<SessionId>()
      const freshSessions: Record<SessionId, SessionMeta> = {}

      for (const [oldId, meta] of agentEntries) {
        try {
          await killSessionBackendIfOwned(refs, oldId)
        } catch {
          // Kill failures still fall through to respawn — the old
          // process may already be gone.
        }

        delete refs.seenUuidsRef.current[oldId]
        clearLiveEntryWindowSession(oldId)
        delete refs.latestScreenRef.current[oldId]

        try {
          const kind: SessionKind = meta.kind ?? DEFAULT_PROVIDER
          const builtInMcpDomains =
            kind !== 'terminal'
              ? normalizeSessionBuiltInMcpDomains(meta.builtInMcpDomains)
              : undefined
          const resumeSessionId = resumableProviderSessionId(meta)
          const restoredMeta = withoutProvisionalProviderSession(meta)
          const { sessionId: newId } = await window.api.spawnSession({
            kind,
            cwd: meta.cwd,
            resumeSessionId,
            dangerousMode,
            useProxy: kind !== 'terminal' ? refs.useProxyStreamingRef.current : undefined,
            builtInMcpDomains,
          })
          idMap.set(oldId, newId)
          freshSessions[newId] = {
            ...restoredMeta,
            ...(builtInMcpDomains ? { builtInMcpDomains } : {}),
          }
        } catch {
          failedIds.add(oldId)
        }
      }

      if (idMap.size === 0 && failedIds.size === 0) return

      setRuntimes(prev => {
        const next: Record<SessionId, SessionRuntime> = { ...prev }
        for (const [oldId] of agentEntries) delete next[oldId]
        for (const [oldId, newId] of idMap.entries()) {
          // WHY merge instead of replacing with a fresh runtime:
          //
          // Codex resume can synchronously replay JSONL and even emit
          // an exit while `window.api.spawnSession()` is still inside
          // provider start. By the time this reload bookkeeping runs,
          // `prev[newId]` may already contain the real lifecycle
          // outcome. Replacing it with `emptyRuntime()` would resurrect
          // a dead process as "started", which is exactly the reload
          // failure mode where the pane looks stuck and Enter reports
          // "Agent has exited".
          const existing = prev[newId]
          const restored: SessionRuntime = { ...(existing ?? emptyRuntime()) }
          restored.draftInput = oldRuntimes[oldId]?.draftInput ?? existing?.draftInput ?? ''
          Object.assign(restored, seedResumedRuntimeFields(existing, freshSessions[newId]))
          next[newId] = restored
        }
        return next
      })

      setState(prev => {
        const nextSessions = pickOwnedSessions(
          prev.sessions,
          collectOwnedSessionIds(prev),
        )
        for (const [oldId] of agentEntries) delete nextSessions[oldId]
        for (const [newId, meta] of Object.entries(freshSessions)) {
          nextSessions[newId] = meta
        }

        const nextTabs = prev.tabs
          .map(tab => {
            let root: TileNode | null = remapTileTreeSessionIds(tab.root, idMap)
            for (const failedId of failedIds) {
              root = closeLeaf(root!, failedId)
              if (root === null) break
            }
            if (root === null) return null
            const leaves = collectLeaves(root)
            if (leaves.length === 0) return null
            const focusedSessionId = idMap.get(tab.focusedSessionId)
              ?? (failedIds.has(tab.focusedSessionId) ? leaves[0] : tab.focusedSessionId)
            return {
              ...tab,
              root,
              focusedSessionId,
            } satisfies Tab
          })
          .filter((tab): tab is Tab => tab !== null)

        const activeTabId = nextTabs.some(tab => tab.id === prev.activeTabId)
          ? prev.activeTabId
          : (nextTabs[0]?.id ?? '')

        const nextBuried = prev.buried
          .filter(entry => !failedIds.has(entry.sessionId))
          .map(entry => ({
            ...entry,
            id: idMap.get(entry.id) ?? entry.id,
            sessionId: idMap.get(entry.sessionId) ?? entry.sessionId,
            siblingLeafId: entry.siblingLeafId
              ? (idMap.get(entry.siblingLeafId) ?? entry.siblingLeafId)
              : undefined,
          }))

        const nextDetachedSessions = Object.fromEntries(
          Object.entries(prev.detachedSessions)
            .filter(([sessionId]) => !failedIds.has(sessionId))
            .map(([sessionId, entry]) => {
              const mapped = idMap.get(sessionId)
              if (!mapped) return [sessionId, entry]
              return [mapped, { ...entry, sessionId: mapped }]
            }),
        )

        const focusedDispatchSessionId = prev.dispatchMode?.focusedSessionId
        // Remap tiled lanes through the same old->new idMap (every reloaded
        // agent got a fresh sessionId), then clear any lane whose session
        // failed to respawn. Without this, "reload all" would point every lane
        // at a dead id and the auto-fill effect would collapse them to tile 0.
        const remappedDispatch = clearTiledLaneSessions(
          remapTiledLanes(prev.dispatchMode, idMap),
          failedIds,
        )
        const nextDispatchMode = remappedDispatch
          ? {
              ...remappedDispatch,
              focusedSessionId: focusedDispatchSessionId
                ? idMap.get(focusedDispatchSessionId) ??
                  (failedIds.has(focusedDispatchSessionId) ? undefined : focusedDispatchSessionId)
                : undefined,
            }
          : null

        return {
          ...prev,
          tabs: nextTabs,
          activeTabId,
          // Reload-all gives every agent a fresh id; remap relationship
          // pointers across all sessions (children keep pointing at the right
          // parent) and remap the pinned list (pins follow to the new ids).
          sessions: remapSessionsRelationships(nextSessions, idMap),
          pinnedSessionIds: remapPinnedSessionIds(prev.pinnedSessionIds, idMap),
          gridRelatedSelections: remapGridRelatedSelections(prev.gridRelatedSelections, idMap),
          detachedSessions: nextDetachedSessions,
          buried: nextBuried,
          dispatchMode: nextDispatchMode,
        }
      })
      for (const [newId, meta] of Object.entries(freshSessions)) {
        if (!hasDurableProviderSession(meta)) continue
        void loadInitialHistoryForSession({
          sessionId: newId,
          meta,
          refs,
          setRuntimes,
        })
      }
    },
    [
      refs.dangerousAgentsRef,
      refs.latestRuntimesRef,
      refs.latestScreenRef,
      refs.seenUuidsRef,
      refs.stateRef,
      refs.useProxyStreamingRef,
      setRuntimes,
      setState,
    ],
  )

  const softReloadAgentView = useCallback(
    async (sessionIdOverride?: SessionId): Promise<SessionId | null> => {
      const snapshot = refs.stateRef.current
      // WHY use command-target focus here: this command is most useful when
      // triaging from Dispatch Mode. The row the user has highlighted may be
      // detached and absent from the grid's focused leaf, so reading only the
      // active tab would refresh the wrong pane.
      const sessionId = sessionIdOverride ?? commandTargetSessionIdForState(snapshot)
      if (!sessionId) return null

      const meta = snapshot.sessions[sessionId]
      if (!meta) return null
      const kind = meta.kind ?? DEFAULT_PROVIDER
      // Soft reload is provider-neutral: it only replaces the renderer's view
      // state for THIS session, without touching the underlying backend. The
      // registry predicate is the right membership check — any agent provider
      // has a renderer view to soft-reload, terminals don't. Prior two-
      // provider literal would silently no-op on OpenCode.
      if (!isAgentProviderKind(kind)) return null

      const hasProviderSession = hasDurableProviderSession(meta)
      if (!hasProviderSession) {
        const timer = refs.bootstrapTimersRef.current.get(sessionId)
        if (timer) {
          clearTimeout(timer)
          refs.bootstrapTimersRef.current.delete(sessionId)
        }
        setRuntimes(prev => {
          const current = prev[sessionId] ?? emptyRuntime()
          return {
            ...prev,
            [sessionId]: softReloadRuntime(current, false),
          }
        })
        return sessionId
      }

      const timer = refs.bootstrapTimersRef.current.get(sessionId)
      if (timer) {
        clearTimeout(timer)
        refs.bootstrapTimersRef.current.delete(sessionId)
      }
      refs.seenUuidsRef.current[sessionId] = new Set()
      // Seen was RESET (not deleted): the trimmed set must reset with it,
      // or the fresh seen set would treat still-trimmed uuids as brand new
      // on the live path while older-history kept releasing them — the
      // trimmed ⊆ ever-seen invariant (liveEntryWindow.ts) would be gone.
      clearLiveEntryWindowSession(sessionId)
      delete refs.latestScreenRef.current[sessionId]

      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        return {
          ...prev,
          [sessionId]: softReloadRuntime(current, hasProviderSession),
        }
      })

      if (hasProviderSession) {
        await loadInitialHistoryForSession({
          sessionId,
          meta,
          refs,
          setRuntimes,
        })
      }

      return sessionId
    },
    [
      refs.bootstrapTimersRef,
      refs.latestScreenRef,
      refs.seenUuidsRef,
      refs.stateRef,
      setRuntimes,
    ],
  )

  return { spawn, ensureSessionLive, killSession, replaceSession, reloadAgentSessions, softReloadAgentView }
}
