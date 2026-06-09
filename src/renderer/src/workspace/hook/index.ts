import { useEffect, useMemo, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { useGlobalToast } from '@renderer/ui/GlobalToast'
import type { WorkspaceModeId } from '@renderer/app-state/settings/types'

import type { WorkspaceHookContext } from '@renderer/workspace/hook/context'
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
import { useHistoryActions } from '@renderer/workspace/hook/actions/history'
import { useUndoCloseAction } from '@renderer/workspace/hook/actions/undoClose'
import { useDispatchActions } from '@renderer/workspace/hook/actions/dispatch'
import { useAutoSave } from '@renderer/workspace/hook/persistence/useAutoSave'
import { useBootstrap, type WorkspaceRestoreStatus } from '@renderer/workspace/hook/persistence/useBootstrap'
import { useFeedDebugPersist } from '@renderer/workspace/hook/persistence/useFeedDebugPersist'
import {
  usePickerSanity,
  usePinnedSessionIdsSanity,
  useReaderModeSanity,
  useSpotlightSanity,
  useTileTabsSanity,
} from '@renderer/workspace/hook/invalidation/effects'
import { useIpcSubscriptions } from '@renderer/workspace/hook/ipc/useIpcSubscriptions'
import type { OrchestrationAgentRecord } from '@mcp/shared/orchestrationTypes'
import {
  closeOrchestrationAgent,
  closeOrchestrationRun,
  listOrchestrationAgents,
  markOrchestrationBootstrapPromptDelivered,
  readOrchestrationAgent,
  readOrchestrationRunOutputs,
} from '@renderer/workspace/orchestrationMcp'

// -----------------------------------------------------------------------------
// useWorkspace — the composer.
//
// Every piece of functionality the hook used to contain inline now
// lives in its own file under ./actions, ./ipc, ./persistence, or
// ./invalidation. This composer reads state from zustand, sets up
// the WorkspaceHookContext (refs + setters + helpers), and wires
// each sub-hook into a single returned object.
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
  )

  // ---- Keep refs in sync with live values on every render ----
  refs.stateRef.current = state
  refs.latestStateRef.current = state
  refs.latestRuntimesRef.current = runtimes
  refs.latestTileTabsRef.current = tileTabs
  refs.dangerousAgentsRef.current = dangerousAgentsEnabled
  refs.useProxyStreamingRef.current = useProxyStreaming

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

  // ---- Runtime helpers (updateRuntime / appendFeedDebug / getRuntime / etc) ----
  const { updateRuntime, appendFeedDebug, acknowledgeSession, getRuntime, toggleTailMode, scrollFocusedToLatest } =
    useWorkspaceHelpers(runtimes, setRuntimes, refs)

  // ---- Pane toast (needs updateRuntime, so after helpers) ----
  const showPaneToast = usePaneToast(refs.paneToastTimers, updateRuntime)

  // ---- Build the canonical context object ----
  //
  // Memoized on identity-stable inputs so ctx itself stays
  // reference-stable for the hook's lifetime. That's critical for
  // useCallback deps downstream — ctx never churns, so callbacks
  // that only depend on ctx stay stable too.
  const ctx: WorkspaceHookContext = useMemo(
    () => ({
      setState,
      setRuntimes,
      setSpotlight,
      setTileTabs,
      setReaderMode,
      openBuryPrompt,
      closeBuryPrompt,
      openNewAgentPlacement,
      closeNewAgentPlacement,
      showToast,
      stateRef: refs.stateRef,
      latestStateRef: refs.latestStateRef,
      latestRuntimesRef: refs.latestRuntimesRef,
      latestTileTabsRef: refs.latestTileTabsRef,
      dangerousAgentsRef: refs.dangerousAgentsRef,
      useProxyStreamingRef: refs.useProxyStreamingRef,
      seenUuidsRef: refs.seenUuidsRef,
      latestScreenRef: refs.latestScreenRef,
      undoStackRef: refs.undoStackRef,
      bootstrapTimersRef: refs.bootstrapTimersRef,
      persistedFeedDebugIdRef: refs.persistedFeedDebugIdRef,
      inFlightFeedDebugIdRef: refs.inFlightFeedDebugIdRef,
      paneToastTimers: refs.paneToastTimers,
      saveTimerRef: refs.saveTimerRef,
      bootRef: refs.bootRef,
      updateRuntime,
      appendFeedDebug,
      setDraftVersion,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  // Silence the unused-ctx warning — other sub-hooks consume it
  // through the destructured args below. Keeping `ctx` built here
  // so future sub-hooks that want a single-param signature have a
  // stable object to consume.
  void ctx

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
  const { spawn, killSession, replaceSession, reloadAgentSessions, softReloadAgentView } =
    sessionActions

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

  useEffect(() => {
    const off = window.api.onOrchestrationRequest(async request => {
      try {
        if (request.type === 'create-agent') {
          const agent = await paneActions.createOrchestrationAgent({
            parentId: request.parentSessionId,
            kind: request.kind,
            cwd: request.cwd,
            title: request.title,
            role: request.role,
            runId: request.runId,
            builtInMcpDomains: request.builtInMcpDomains,
            // WHY the request field is intentionally not forwarded:
            // older MCP tool schemas can still send `inheritParentContext`,
            // but context inheritance is disabled until it can be rebuilt on a
            // stable provider-resume contract. The renderer spawn path is the
            // final authority for whether a child receives a cloned transcript,
            // so forcing clean children here prevents stale clients from
            // accidentally reviving the broken behavior.
            inheritParentContext: false,
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
            closeSession: paneActions.closeSession,
          })
          await window.api.resolveOrchestrationRequest({
            requestId: request.requestId,
            ok: true,
            type: 'close-agent',
            result,
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
          closeSession: paneActions.closeSession,
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
  }, [paneActions, refs.stateRef])

  const { switchFocusedProvider, reloadFocusedAgent, rewindFocusedToPrompt, undoLastRewind } =
    useProviderActions(refs, setRuntimes, showPaneToast, sessionActions)

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
  useIpcSubscriptions(refs, setState, setRuntimes, updateRuntime, appendFeedDebug)
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
    scrollFocusedToLatest,
    pickerEnter,
    pickerMove,
    pickerConfirm,
    pickerCancel,
    setCodeBlockPicker,
    enterDispatchMode: dispatchActions.enterDispatchMode,
    exitDispatchMode: dispatchActions.exitDispatchMode,
    setDispatchScope: dispatchActions.setDispatchScope,
    ensureDispatchTerminal: dispatchActions.ensureDispatchTerminal,
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
