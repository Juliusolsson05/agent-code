import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { useGlobalToast } from '@renderer/ui/GlobalToast'
import type { WorkspaceModeId } from '@renderer/app-state/settings/types'
import type { ConfigurableBuiltInMcpDomain } from '@mcp/shared/types'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentViewModeOverride, SessionId } from '@renderer/workspace/types'

import { useWorkspaceRefs } from '@renderer/workspace/hook/refs'
import { usePaneToast, useWorkspaceHelpers } from '@renderer/workspace/hook/helpers'
import { useDraftActions } from '@renderer/workspace/hook/actions/draft'
import { useStreamingActions } from '@renderer/workspace/hook/actions/streaming'
import { usePickerActions } from '@renderer/workspace/hook/actions/picker'
import { useSpotlightActions } from '@renderer/workspace/hook/actions/spotlight'
import { useReaderActions } from '@renderer/workspace/hook/actions/reader'
import { useTileTabsActions } from '@renderer/workspace/hook/actions/tileTabs'
import { useResizeActions } from '@renderer/workspace/hook/actions/resize'
import { useSessionActions } from '@renderer/workspace/hook/actions/session'
import { useTabActions } from '@renderer/workspace/hook/actions/tab'
import { usePaneActions } from '@renderer/workspace/hook/actions/pane'
import { useProviderActions } from '@renderer/workspace/hook/actions/provider'
import { useBulkProviderSwitchActions } from '@renderer/workspace/hook/actions/bulkProviderSwitch'
import { useHistoryActions } from '@renderer/workspace/hook/actions/history'
import { useUndoCloseAction } from '@renderer/workspace/hook/actions/undoClose'
import { useDispatchActions } from '@renderer/workspace/hook/actions/dispatch'
import { useAgentIndexNavigationActions } from '@renderer/workspace/hook/actions/agentIndexNavigation'
import { useAutoSave } from '@renderer/workspace/hook/persistence/useAutoSave'
import { useBootstrap } from '@renderer/workspace/hook/persistence/useBootstrap'
import type { WorkspaceRestoreStatus } from '@renderer/workspace/hook/persistence/useBootstrap'
import { useFeedDebugPersist } from '@renderer/workspace/hook/persistence/useFeedDebugPersist'
import {
  usePickerSanity,
  usePinnedSessionIdsSanity,
  useReaderModeSanity,
  useSpotlightSanity,
  useTileTabsSanity,
} from '@renderer/workspace/hook/invalidation/effects'
import { useIpcSubscriptions } from '@renderer/workspace/hook/ipc/useIpcSubscriptions'
import { useSessionFeed } from '@renderer/features/sessionFeed/SessionFeedContext'
import type { OrchestrationAgentRecord } from '@mcp/shared/orchestrationTypes'
import type { AgentManagementRendererResponse } from '@mcp/shared/agentManagementTypes'
import {
  closeOrchestrationAgent,
  closeOrchestrationRun,
  listOrchestrationAgents,
  markOrchestrationBootstrapPromptDelivered,
  readOrchestrationAgent,
  readOrchestrationRunOutputs,
} from '@renderer/workspace/orchestrationMcp'
import {
  additionalCloseImpact,
  assertManagedTarget,
  listManagedAgentDescriptors,
  managedTranscriptUnavailableReason,
  readManagedAgentOutput,
  readManagedAgentOutputs,
} from '@renderer/workspace/agentManagementMcp'
import { loadInitialHistoryForSession } from '@renderer/workspace/hook/actions/initialHistory'

// -----------------------------------------------------------------------------
// useWorkspace — the composer.
//
// Every piece of functionality the hook used to contain inline now
// lives in its own file under ./actions, ./ipc, ./persistence, or
// ./invalidation. This composer reads state from zustand, sets up
// refs, setters, and helpers, then wires each sub-hook into a single returned
// object.
//
// Returning a stable shape is the only hard contract: consumers
// destructure fields off `Workspace` and if a sub-hook moves a
// method's name the caller breaks. Keep the return block alphabetic
// and avoid renames.
// -----------------------------------------------------------------------------

export type Workspace = ReturnType<typeof useWorkspace>

export function useWorkspace(
  dangerousAgentsEnabled = false,
  useProxyStreaming = false,
  // Read once at mount via useBootstrap's useEffect closure. Live
  // changes to this preference do not retro-trigger bootstrap — that
  // is intentional, the setting only seeds initial state on a fresh
  // install (no workspace.json yet).
  defaultWorkspaceMode: WorkspaceModeId = 'grid',
  defaultBuiltInMcpDomains: ConfigurableBuiltInMcpDomain[] = [],
) {
  // ---- Zustand subscriptions (these drive re-renders) ----
  const { showToast } = useGlobalToast()
  const openBuryPrompt = useAppStore(store => store.openBuryPrompt)
  const closeBuryPrompt = useAppStore(store => store.closeBuryPrompt)
  const openNewAgentPlacement = useAppStore(store => store.openNewAgentPlacement)
  const closeNewAgentPlacement = useAppStore(store => store.closeNewAgentPlacement)

  const state = useAppStore(store => store.workspaceState)
  const setState = useAppStore(store => store.setWorkspaceState)
  const runtimes = useAppStore(store => store.workspaceRuntimes)
  const setRuntimes = useAppStore(store => store.setWorkspaceRuntimes)
  const spotlight = useAppStore(store => store.workspaceSpotlight)
  const setSpotlight = useAppStore(store => store.setWorkspaceSpotlight)
  const tileTabs = useAppStore(store => store.workspaceTileTabs)
  const setTileTabs = useAppStore(store => store.setWorkspaceTileTabs)
  const readerMode = useAppStore(store => store.workspaceReaderMode)
  const setReaderMode = useAppStore(store => store.setWorkspaceReaderMode)

  // ---- Refs (identity-stable across renders) ----
  const refs = useWorkspaceRefs(
    state,
    runtimes,
    tileTabs,
    dangerousAgentsEnabled,
    useProxyStreaming,
    defaultBuiltInMcpDomains,
  )

  // ---- Keep refs in sync with live values on every render ----
  refs.stateRef.current = state
  refs.latestStateRef.current = state
  refs.latestRuntimesRef.current = runtimes
  refs.latestTileTabsRef.current = tileTabs
  refs.dangerousAgentsRef.current = dangerousAgentsEnabled
  refs.useProxyStreamingRef.current = useProxyStreaming
  refs.defaultBuiltInMcpDomainsRef.current = defaultBuiltInMcpDomains

  // ---- Draft version counter (React state because the save effect
  //      reads it as a dep) ----
  const [draftVersion, setDraftVersion] = useState(0)
  const [bootstrapComplete, setBootstrapComplete] = useState(false)
  // Surfaces the bootstrap outcome to the UI so it can render a banner
  // when the workspace is in a partial-restore / persisted-fallback
  // state. Lives outside `bootstrapComplete` because that boolean only
  // says "are we past the once-only effect", not "is the on-disk state
  // intact". See useBootstrap for the four possible terminal values.
  const [restoreStatus, setRestoreStatus] = useState<WorkspaceRestoreStatus>('pending')
  const selectGridRelatedSession = useCallback((ownerSessionId: string, selectedSessionId: string) => {
    setState(prev => {
      const nextSelections = { ...(prev.gridRelatedSelections ?? {}) }
      if (ownerSessionId === selectedSessionId) {
        delete nextSelections[ownerSessionId]
      } else {
        nextSelections[ownerSessionId] = selectedSessionId
      }
      return {
        ...prev,
        gridRelatedSelections: nextSelections,
      }
    })
  }, [setState])

  const setSessionAgentViewModeOverride = useCallback((
    sessionId: SessionId,
    override: AgentViewModeOverride | null,
  ): boolean => {
    const snapshot = refs.stateRef.current
    const meta = snapshot.sessions[sessionId]
    if (!meta) return false
    const kind = meta.kind ?? DEFAULT_PROVIDER
    if (!isAgentProviderKind(kind)) return false
    if (kind === 'opencode' && override === 'terminal') {
      // WHY this repeats the render-policy guard instead of relying only on
      // getEffectiveAgentSurface: this field is durable workspace metadata.
      // Persisting "terminal" on an OpenCode session today would make
      // workspace.json claim an intent the provider cannot satisfy, then force
      // future native-mode work to distinguish "real user override" from
      // "stale impossible override." Reject it at the write boundary; the
      // display-policy pin remains the read-side safety net.
      showToast('OpenCode native terminal mode is not available yet')
      return false
    }

    setState(prev => {
      const current = prev.sessions[sessionId]
      if (!current) return prev
      const sessions = { ...prev.sessions }
      if (override === null) {
        const { agentViewModeOverride: _removed, ...rest } = current
        sessions[sessionId] = rest
      } else {
        sessions[sessionId] = {
          ...current,
          agentViewModeOverride: override,
        }
      }
      return {
        ...prev,
        sessions,
      }
    })
    if (override === 'terminal') {
      setRuntimes(prev => {
        const current = prev[sessionId]
        if (!current) return prev
        if (
          !current.assistantPicker &&
          !current.codeBlockPicker &&
          Object.keys(current.renderedViewLeases).length === 0
        ) {
          return prev
        }
        return {
          ...prev,
          [sessionId]: {
            ...current,
            assistantPicker: null,
            codeBlockPicker: null,
            renderedViewLeases: {},
          },
        }
      })
    }
    return true
  }, [refs.stateRef, setRuntimes, setState, showToast])

  // ---- Runtime helpers (updateRuntime / appendFeedDebug / getRuntime / etc) ----
  const {
    updateRuntime,
    appendFeedDebug,
    acknowledgeSession,
    getRuntime,
    toggleTailMode,
    acquireRenderedViewLease,
    releaseRenderedViewLease,
    releaseAllRenderedViewLeases,
    scrollFocusedToLatest,
  } =
    useWorkspaceHelpers(runtimes, setRuntimes, refs)

  // ---- Pane toast (needs updateRuntime, so after helpers) ----
  const showPaneToast = usePaneToast(refs.paneToastTimers, updateRuntime)

  // ---- Actions ----
  const { setDraftInput, setDraftImages } = useDraftActions(
    setRuntimes,
    updateRuntime,
    setDraftVersion,
  )
  const {
    setStreamingBaseline,
    clearPendingRewindUndo,
    addOptimisticCodexUserEntry,
    removeOptimisticCodexUserEntry,
  } =
    useStreamingActions(setRuntimes)
  const { pickerEnter, pickerMove, pickerCancel, pickerConfirm, setCodeBlockPicker } =
    usePickerActions(setRuntimes, refs, showPaneToast)
  const { toggleSpotlight, setSpotlightSession } = useSpotlightActions(
    setSpotlight,
    setState,
    refs,
  )
  const { toggleReaderMode, setReaderModeSession } = useReaderActions(
    setReaderMode,
    setSpotlight,
    setState,
    refs,
  )
  const {
    openTileTabs,
    closeTileTabs,
    focusTiledTab,
    focusTiledTabByIndex,
    resizeFocusedTiledTab,
    resizeTiledTabByIndex,
  } = useTileTabsActions(setTileTabs, setSpotlight, setState, refs)
  const {
    resizeFocused,
    resizeFocusedDirectional,
    setSplitRatio,
    setSplitRatioInTab,
    normalizeLayout,
    hardNormalizeLayout,
    rotateLayout,
  } = useResizeActions(setState, setTileTabs)

  // Session lifecycle + derivatives that depend on it
  const sessionActions = useSessionActions(state, setState, setRuntimes, refs)
  const { spawn, ensureSessionLive, killSession, replaceSession, reloadAgentSessions, softReloadAgentView } =
    sessionActions
  const ensureSessionLiveRef = useRef(ensureSessionLive)
  ensureSessionLiveRef.current = ensureSessionLive

  const { focusAgentByPaneLabel } = useAgentIndexNavigationActions(
    setState,
    setTileTabs,
    refs,
    sessionActions,
    showToast,
  )

  const tabActions = useTabActions(
    state,
    tileTabs,
    setState,
    setRuntimes,
    setTileTabs,
    setSpotlight,
    setReaderMode,
    refs,
    showToast,
    sessionActions,
  )

  const paneActions = usePaneActions(
    state,
    setState,
    setRuntimes,
    setSpotlight,
    setTileTabs,
    refs,
    showToast,
    openBuryPrompt,
    closeBuryPrompt,
    openNewAgentPlacement,
    closeNewAgentPlacement,
    sessionActions,
  )
  const createOrchestrationAgentRef = useRef(paneActions.createOrchestrationAgent)
  createOrchestrationAgentRef.current = paneActions.createOrchestrationAgent
  const closeOrchestrationSessionRef = useRef(paneActions.closeSession)
  closeOrchestrationSessionRef.current = paneActions.closeSession
  const killBuriedSessionRef = useRef(paneActions.killBuried)
  killBuriedSessionRef.current = paneActions.killBuried

  useEffect(() => {
    const off = window.api.onOrchestrationRequest(async request => {
      try {
        if (request.type === 'create-agent') {
          const agent = await createOrchestrationAgentRef.current({
            parentId: request.parentSessionId,
            kind: request.kind,
            cwd: request.cwd,
            title: request.title,
            role: request.role,
            runId: request.runId,
            builtInMcpDomains: request.builtInMcpDomains,
            // WHY the request field is intentionally omitted:
            // older MCP tool schemas can still send `inheritParentContext`,
            // but context inheritance is disabled until it can be rebuilt on a
            // stable provider-resume contract. The renderer spawn path is the
            // final authority for whether a child receives a cloned transcript,
            // so forcing clean children here prevents stale clients from
            // accidentally reviving the broken behavior.
          })
          await window.api.resolveOrchestrationRequest({
            requestId: request.requestId,
            ok: true,
            type: 'create-agent',
            agent,
          })
          return
        }

        const snapshot = refs.stateRef.current
        const runtimes = refs.latestRuntimesRef.current
        if (request.type === 'list-agents') {
          const agents: OrchestrationAgentRecord[] = listOrchestrationAgents({
            state: snapshot,
            runtimes,
            parentSessionId: request.parentSessionId,
            runId: request.runId,
          })

          await window.api.resolveOrchestrationRequest({
            requestId: request.requestId,
            ok: true,
            type: 'list-agents',
            agents,
          })
          return
        }

        if (request.type === 'read-agent') {
          const output = readOrchestrationAgent({
            state: snapshot,
            runtimes,
            parentSessionId: request.parentSessionId,
            sessionId: request.sessionId,
            maxMessages: request.maxMessages,
            maxCharsPerMessage: request.maxCharsPerMessage,
            maxCharsPerAgent: request.maxCharsPerAgent,
          })
          await window.api.resolveOrchestrationRequest({
            requestId: request.requestId,
            ok: true,
            type: 'read-agent',
            output,
          })
          return
        }

        if (request.type === 'read-run-outputs') {
          const outputs = readOrchestrationRunOutputs({
            state: snapshot,
            runtimes,
            parentSessionId: request.parentSessionId,
            runId: request.runId,
            maxMessagesPerAgent: request.maxMessagesPerAgent,
            maxCharsPerMessage: request.maxCharsPerMessage,
            maxCharsPerAgent: request.maxCharsPerAgent,
          })
          await window.api.resolveOrchestrationRequest({
            requestId: request.requestId,
            ok: true,
            type: 'read-run-outputs',
            outputs,
          })
          return
        }

        if (request.type === 'close-agent') {
          const result = await closeOrchestrationAgent({
            state: snapshot,
            parentSessionId: request.parentSessionId,
            sessionId: request.sessionId,
            closeSession: closeOrchestrationSessionRef.current,
          })
          await window.api.resolveOrchestrationRequest({
            requestId: request.requestId,
            ok: true,
            type: 'close-agent',
            result,
          })
          return
        }

        if (request.type === 'ensure-agent-live') {
          // WHY orchestration wake is renderer-mediated:
          // main can tell whether a provider process exists, but only the
          // renderer owns durable workspace metadata and orchestration
          // visibility. After a full app restart, parked/listed agents can
          // still be valid children in workspace.json while main's in-memory
          // SessionManager has no PTY for that SessionId. Waking here keeps the
          // same id and therefore preserves Dispatch nesting, parent/root
          // ownership, and any MCP caller that already named the child.
          readOrchestrationAgent({
            state: snapshot,
            runtimes,
            parentSessionId: request.parentSessionId,
            sessionId: request.sessionId,
            maxMessages: 1,
          })
          await ensureSessionLiveRef.current(request.sessionId)
          const agent = readOrchestrationAgent({
            state: refs.stateRef.current,
            runtimes: refs.latestRuntimesRef.current,
            parentSessionId: request.parentSessionId,
            sessionId: request.sessionId,
            maxMessages: 1,
          }).agent
          await window.api.resolveOrchestrationRequest({
            requestId: request.requestId,
            ok: true,
            type: 'ensure-agent-live',
            agent,
          })
          return
        }

        if (request.type === 'mark-bootstrap-prompt-delivered') {
          const output = readOrchestrationAgent({
            state: snapshot,
            runtimes,
            parentSessionId: request.parentSessionId,
            sessionId: request.sessionId,
            maxMessages: 1,
          })
          setState(prev => {
            return markOrchestrationBootstrapPromptDelivered({
              state: prev,
              parentSessionId: request.parentSessionId,
              sessionId: request.sessionId,
            })
          })
          await window.api.resolveOrchestrationRequest({
            requestId: request.requestId,
            ok: true,
            type: 'mark-bootstrap-prompt-delivered',
            agent: {
              ...output.agent,
              orchestrationBootstrapPromptDelivered: true,
            },
          })
          return
        }

        const result = await closeOrchestrationRun({
          state: snapshot,
          parentSessionId: request.parentSessionId,
          runId: request.runId,
          closeSession: closeOrchestrationSessionRef.current,
        })
        await window.api.resolveOrchestrationRequest({
          requestId: request.requestId,
          ok: true,
          type: 'close-run',
          result,
        })
      } catch (err) {
        await window.api.resolveOrchestrationRequest({
          requestId: request.requestId,
          ok: false,
          type: request.type,
          message: err instanceof Error && err.message.length > 0
            ? err.message
            : 'Orchestration request failed',
        })
      }
    })
    return off
  }, [refs.latestRuntimesRef, refs.stateRef, setState])

  useEffect(() => {
    const resolveFailure = async (
      requestId: string,
      type: AgentManagementRendererResponse['type'],
      error: unknown,
      sessionId?: string,
    ): Promise<void> => {
      const candidate = error instanceof Error ? error.message : 'request_failed'
      const knownCodes = new Set([
        'caller_not_found',
        'agent_not_found',
        'agent_not_in_project',
        'self_target_forbidden',
        'transcript_unavailable',
      ] as const)
      const code = knownCodes.has(candidate as never)
        ? candidate as Extract<AgentManagementRendererResponse, { ok: false }>['code']
        : 'request_failed'
      await window.api.resolveAgentManagementRequest({
        requestId,
        ok: false,
        type,
        code,
        message: code === 'request_failed'
          ? (error instanceof Error && error.message.length > 0
              ? error.message
              : 'Agent management request failed.')
          : `Agent management request rejected: ${code}.`,
        ...(sessionId ? { sessionId } : {}),
      })
    }

    const hydrateTranscriptWithoutWaking = async (
      sessionId: string,
    ): Promise<'transcript_unavailable' | 'not_created' | null> => {
      const before = useAppStore.getState()
      const meta = before.workspaceState.sessions[sessionId]
      const runtime = before.workspaceRuntimes[sessionId]
      if (!meta || !runtime || runtime.transcriptStatus === 'ready') {
        return managedTranscriptUnavailableReason(runtime, meta)
      }
      // WHY audit reads call the durable-history loader directly instead of
      // ensureSessionLive: restored and buried agents remain valid project
      // records even with no provider process. Transcript inspection must not
      // wake them, mutate their backend lifetime, or consume a provider turn.
      await loadInitialHistoryForSession({ sessionId, refs, setRuntimes, meta })
      // Zustand updates synchronously, while the React render that refreshes
      // latestRuntimesRef may happen after this promise continuation. Reading
      // the store directly prevents a successful/error hydration from being
      // mistaken for the stale pre-load runtime in the same MCP request.
      const after = useAppStore.getState()
      return managedTranscriptUnavailableReason(
        after.workspaceRuntimes[sessionId],
        after.workspaceState.sessions[sessionId],
      )
    }

    const off = window.api.onAgentManagementRequest(async request => {
      try {
        if (request.type === 'list-agents') {
          const listed = listManagedAgentDescriptors({
            state: refs.stateRef.current,
            runtimes: refs.latestRuntimesRef.current,
            callerSessionId: request.callerSessionId,
          })
          await window.api.resolveAgentManagementRequest({
            requestId: request.requestId,
            ok: true,
            type: 'list-agents',
            observedAt: Date.now(),
            ...listed,
          })
          return
        }

        if (request.type === 'read-agent') {
          assertManagedTarget({
            state: refs.stateRef.current,
            callerSessionId: request.callerSessionId,
            sessionId: request.sessionId,
            allowSelf: true,
          })
          const unavailable = await hydrateTranscriptWithoutWaking(request.sessionId)
          if (unavailable) throw new Error('transcript_unavailable')
          const current = useAppStore.getState()
          const output = readManagedAgentOutput({
            state: current.workspaceState,
            runtimes: current.workspaceRuntimes,
            callerSessionId: request.callerSessionId,
            sessionId: request.sessionId,
            maxMessages: request.maxMessages,
            maxCharsPerMessage: request.maxCharsPerMessage,
            maxCharsPerAgent: request.maxCharsPerAgent,
          })
          await window.api.resolveAgentManagementRequest({
            requestId: request.requestId,
            ok: true,
            type: 'read-agent',
            observedAt: Date.now(),
            output,
          })
          return
        }

        if (request.type === 'read-agents') {
          const listed = listManagedAgentDescriptors({
            state: refs.stateRef.current,
            runtimes: refs.latestRuntimesRef.current,
            callerSessionId: request.callerSessionId,
          })
          const listedIds = new Set(listed.agents.map(item => item.agent.sessionId))
          let targetIds = request.sessionIds
            ? [...new Set(request.sessionIds)]
            : listed.agents
                .filter(item => request.includeCaller === true || !item.agent.isCaller)
                .map(item => item.agent.sessionId)
          for (const sessionId of targetIds) {
            if (!listedIds.has(sessionId)) throw new Error('agent_not_in_project')
          }
          // loadInitialHistoryForSession contains a two-slot limiter, so this
          // preserves bulk-read latency without turning a large project audit
          // into unbounded filesystem/IPC work.
          const unavailableById = new Map(
            (await Promise.all(targetIds.map(async sessionId => ({
              sessionId,
              reason: await hydrateTranscriptWithoutWaking(sessionId),
            }))))
              .filter((item): item is {
                sessionId: string
                reason: 'transcript_unavailable' | 'not_created'
              } => item.reason !== null)
              .map(item => [item.sessionId, item] as const),
          )
          const current = useAppStore.getState()
          if (!request.sessionIds) {
            const originalIds = new Set(targetIds)
            const fresh = listManagedAgentDescriptors({
              state: current.workspaceState,
              runtimes: current.workspaceRuntimes,
              callerSessionId: request.callerSessionId,
            })
            // WHY the implicit fleet read tolerates departures while an
            // explicit subset remains strict: "read all" describes a census,
            // not a transaction over identities the caller selected. Keep the
            // original observation boundary, drop agents the user closed during
            // hydration, and let the fresh inventory still reveal new arrivals.
            targetIds = fresh.agents
              .filter(item => originalIds.has(item.agent.sessionId))
              .filter(item => request.includeCaller === true || !item.agent.isCaller)
              .map(item => item.agent.sessionId)
          }
          const result = readManagedAgentOutputs({
            state: current.workspaceState,
            runtimes: current.workspaceRuntimes,
            callerSessionId: request.callerSessionId,
            sessionIds: targetIds,
            includeCaller: request.includeCaller,
            maxMessagesPerAgent: request.maxMessagesPerAgent,
            maxCharsPerMessage: request.maxCharsPerMessage,
            maxCharsPerAgent: request.maxCharsPerAgent,
            maxTotalChars: request.maxTotalChars,
          })
          await window.api.resolveAgentManagementRequest({
            requestId: request.requestId,
            ok: true,
            type: 'read-agents',
            observedAt: Date.now(),
            ...result,
            unavailable: targetIds.flatMap(sessionId => {
              const item = unavailableById.get(sessionId)
              return item ? [item] : []
            }),
          })
          return
        }

        if (request.type === 'send-prompt') {
          assertManagedTarget({
            state: refs.stateRef.current,
            callerSessionId: request.callerSessionId,
            sessionId: request.sessionId,
          })
          // Sending is the one operation that intentionally wakes a parked
          // target. Re-authorize after the await because the user can move or
          // close a pane while the provider is starting.
          await ensureSessionLiveRef.current(request.sessionId)
          assertManagedTarget({
            state: refs.stateRef.current,
            callerSessionId: request.callerSessionId,
            sessionId: request.sessionId,
          })
          const delivery = await window.api.deliverPrompt(request.sessionId, request.prompt)
          await window.api.resolveAgentManagementRequest({
            requestId: request.requestId,
            ok: true,
            type: 'send-prompt',
            sessionId: request.sessionId,
            delivery,
          })
          return
        }

        // Closing is structurally narrower than the UI close operation. The UI
        // intentionally cascades linked children and can remove a whole tab;
        // MCP must refuse those shapes so one named target never silently means
        // several agents. The model-facing tool adds the separate requirement
        // that the current user explicitly requested closure.
        const affected = additionalCloseImpact({
          state: refs.stateRef.current,
          callerSessionId: request.callerSessionId,
          sessionId: request.sessionId,
        })
        if (affected.length > 0) {
          await window.api.resolveAgentManagementRequest({
            requestId: request.requestId,
            ok: false,
            type: 'close-agent',
            code: 'close_would_affect_additional_sessions',
            message: 'Closing this target would also affect additional project sessions.',
            sessionId: request.sessionId,
            additionalAffectedSessionIds: affected,
          })
          return
        }
        const current = refs.stateRef.current
        const placement = assertManagedTarget({
          state: current,
          callerSessionId: request.callerSessionId,
          sessionId: request.sessionId,
        })
        if (placement.placement === 'buried') {
          const buried = current.buried.find(item => item.sessionId === request.sessionId)
          if (!buried) throw new Error('agent_not_found')
          await killBuriedSessionRef.current(buried.id)
        } else {
          await closeOrchestrationSessionRef.current(request.sessionId)
        }
        await window.api.resolveAgentManagementRequest({
          requestId: request.requestId,
          ok: true,
          type: 'close-agent',
          closedSessionId: request.sessionId,
        })
      } catch (error) {
        await resolveFailure(
          request.requestId,
          request.type,
          error,
          'sessionId' in request ? request.sessionId : undefined,
        )
      }
    })
    return off
  }, [refs, setRuntimes])

  const { switchFocusedProvider, reloadFocusedAgent, rewindFocusedToPrompt, undoLastRewind } =
    useProviderActions(refs, setRuntimes, showPaneToast, sessionActions)

  // Bulk provider switch (Switch Agents modal) + remembered-batch return. Uses
  // the same single-agent core as switchFocusedProvider, but reports through the
  // global toast (the operation spans many panes, so a pane-scoped toast would
  // be arbitrary) and records the batch on workspace state.
  const { switchAgentsToProvider, returnLastProviderSwitchBatch } =
    useBulkProviderSwitchActions(refs, setState, setRuntimes, showToast, sessionActions)

  const { loadOlderHistory } = useHistoryActions(setRuntimes, refs, updateRuntime)

  const { undoClose, undoCloseCount } = useUndoCloseAction(
    state,
    setState,
    refs,
    sessionActions,
  )

  const dispatchActions = useDispatchActions(
    state,
    setState,
    setTileTabs,
    refs,
    showToast,
    closeNewAgentPlacement,
    sessionActions,
  )

  // ---- Side-effects (subscriptions, persistence, invalidation) ----
  // Session events arrive through whichever SessionFeed the app root mounted
  // (desktop: ipcSessionFeed in app/main.tsx; remote client: its WebSocket
  // feed; tests: FakeSessionFeed). The provider value is a module const, so
  // identity is stable — which the subscription effect's dep array requires;
  // see the WHY on useIpcSubscriptions.
  const sessionFeed = useSessionFeed()
  useIpcSubscriptions(sessionFeed, refs, setState, setRuntimes, updateRuntime, appendFeedDebug)
  useAutoSave(state, draftVersion, refs, bootstrapComplete)
  useBootstrap(
    refs,
    setState,
    setRuntimes,
    setTileTabs,
    tabActions.newTab,
    setBootstrapComplete,
    setRestoreStatus,
    defaultWorkspaceMode,
    dispatchActions.enterDispatchMode,
  )
  useFeedDebugPersist(runtimes, refs)
  useSpotlightSanity(spotlight, state, setSpotlight)
  useReaderModeSanity(readerMode, state, setReaderMode)
  usePickerSanity(runtimes, pickerCancel)
  useTileTabsSanity(tileTabs, state.tabs, setTileTabs)
  usePinnedSessionIdsSanity(state, setState)

  // ---- Derived values ----
  const activeTab = useMemo(
    () => state.tabs.find(t => t.id === state.activeTabId) ?? null,
    [state.activeTabId, state.tabs],
  )

  // Silence unused-var warning for useEffect import (may be
  // needed by future sub-hooks added to this composer).
  void useEffect

  // ---- Return the stable Workspace shape ----
  return {
    state,
    runtimes,
    activeTab,
    spotlight,
    tileTabs,
    readerMode,
    dispatchMode: state.dispatchMode,
    restoreStatus,
    toggleReaderMode,
    setReaderModeSession,
    latestScreenRef: refs.latestScreenRef,
    getRuntime,
    // Patch a session's runtime (sessionId, partial). Used by TileLeaf for
    // pane toasts and the prompt-suggestion chip's apply/dismiss handlers.
    // It was destructured above and wired into sub-hooks but never exposed
    // on the returned Workspace object, so `workspace.updateRuntime(...)`
    // threw "is not a function" at runtime (vite strips types, so the build
    // never caught the missing member). Exposing it here is the whole fix.
    updateRuntime,
    // actions
    newTab: tabActions.newTab,
    closeTab: tabActions.closeTab,
    spawn,
    ensureSessionLive,
    killSession,
    splitFocused: paneActions.splitFocused,
    startNewAgentPlacement: paneActions.startNewAgentPlacement,
    commitNewAgentPlacement: paneActions.commitNewAgentPlacement,
    createDetachedDispatchAgent: paneActions.createDetachedDispatchAgent,
    createLinkedAgent: paneActions.createLinkedAgent,
    createOrchestrationAgent: paneActions.createOrchestrationAgent,
    attachDetachedToGrid: paneActions.attachDetachedToGrid,
    attachAllDetachedForTab: paneActions.attachAllDetachedForTab,
    detachFocusedToDispatch: paneActions.detachFocusedToDispatch,
    closeFocused: paneActions.closeFocused,
    closeSession: paneActions.closeSession,
    requestBuryFocused: paneActions.requestBuryFocused,
    buryFocused: paneActions.buryFocused,
    reviveBuried: paneActions.reviveBuried,
    killBuried: paneActions.killBuried,
    focusSession: paneActions.focusSession,
    focusSessionInTab: paneActions.focusSessionInTab,
    focusAgentByPaneLabel,
    setSessionAgentViewModeOverride,
    selectGridRelatedSession,
    navigate: paneActions.navigate,
    activateTab: tabActions.activateTab,
    activateTabByIndex: tabActions.activateTabByIndex,
    reorderTabs: tabActions.reorderTabs,
    nextTab: tabActions.nextTab,
    prevTab: tabActions.prevTab,
    resizeFocused,
    resizeFocusedDirectional,
    setSplitRatio,
    setSplitRatioInTab,
    setStreamingBaseline,
    clearPendingRewindUndo,
    acknowledgeSession,
    appendFeedDebug,
    addOptimisticCodexUserEntry,
    removeOptimisticCodexUserEntry,
    setDraftInput,
    setDraftImages,
    loadOlderHistory,
    showPaneToast,
    undoClose,
    undoCloseCount,
    normalizeLayout,
    hardNormalizeLayout,
    rotateLayout,
    replaceSession,
    reloadFocusedAgent,
    softReloadAgentView,
    switchFocusedProvider,
    switchAgentsToProvider,
    returnLastProviderSwitchBatch,
    rewindFocusedToPrompt,
    undoLastRewind,
    reloadAgentSessions,
    toggleSpotlight,
    setSpotlightSession,
    openTileTabs,
    closeTileTabs,
    focusTiledTab,
    focusTiledTabByIndex,
    resizeFocusedTiledTab,
    resizeTiledTabByIndex,
    toggleTailMode,
    acquireRenderedViewLease,
    releaseRenderedViewLease,
    releaseAllRenderedViewLeases,
    scrollFocusedToLatest,
    pickerEnter,
    pickerMove,
    pickerConfirm,
    pickerCancel,
    setCodeBlockPicker,
    enterDispatchMode: dispatchActions.enterDispatchMode,
    exitDispatchMode: dispatchActions.exitDispatchMode,
    setDispatchScope: dispatchActions.setDispatchScope,
    focusDispatchSession: dispatchActions.focusDispatchSession,
    pinSession: dispatchActions.pinSession,
    unpinSession: dispatchActions.unpinSession,
    setPinnedSessionIds: dispatchActions.setPinnedSessionIds,
    enterTiledDispatch: dispatchActions.enterTiledDispatch,
    exitTiledDispatch: dispatchActions.exitTiledDispatch,
    setTiledLaneSession: dispatchActions.setTiledLaneSession,
    setTiledLaneCount: dispatchActions.setTiledLaneCount,
    setTiledFocusedLane: dispatchActions.setTiledFocusedLane,
    setTiledRatios: dispatchActions.setTiledRatios,
  }
}
