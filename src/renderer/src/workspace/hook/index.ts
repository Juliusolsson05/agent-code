import { useEffect, useMemo, useState } from 'react'

import { useAppStore } from '@renderer/state/hooks'
import { useGlobalToast } from '@renderer/ui/GlobalToast'

import type { WorkspaceHookContext } from '@renderer/workspace/hook/context'
import { useWorkspaceRefs } from '@renderer/workspace/hook/refs'
import { usePaneToast, useWorkspaceHelpers } from '@renderer/workspace/hook/helpers'
import { useStatusModeActions } from '@renderer/workspace/hook/actions/statusMode'
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
import { useAutoSave } from '@renderer/workspace/hook/persistence/useAutoSave'
import { useBootstrap } from '@renderer/workspace/hook/persistence/useBootstrap'
import { useFeedDebugPersist } from '@renderer/workspace/hook/persistence/useFeedDebugPersist'
import {
  usePickerSanity,
  useReaderModeSanity,
  useSpotlightSanity,
  useTileTabsSanity,
} from '@renderer/workspace/hook/invalidation/effects'
import { useIpcSubscriptions } from '@renderer/workspace/hook/ipc/useIpcSubscriptions'

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
  const statusMode = useAppStore(store => store.workspaceStatusMode)
  const setStatusMode = useAppStore(store => store.setWorkspaceStatusMode)

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

  // ---- Runtime helpers (updateRuntime / appendFeedDebug / getRuntime / etc) ----
  const { updateRuntime, appendFeedDebug, getRuntime, toggleTailMode, scrollFocusedToLatest } =
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
      setStatusMode,
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
  const { toggleStatusMode } = useStatusModeActions(setStatusMode)
  const { setDraftInput, setDraftImages } = useDraftActions(
    setRuntimes,
    updateRuntime,
    setDraftVersion,
  )
  const { setStreamingBaseline, addOptimisticCodexUserEntry, removeOptimisticCodexUserEntry } =
    useStreamingActions(setRuntimes)
  const { pickerEnter, pickerMove, pickerCancel, pickerConfirm } = usePickerActions(
    setRuntimes,
    refs,
    showPaneToast,
  )
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
  const { spawn, killSession, replaceSession, reloadAgentSessions } = sessionActions

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

  const { switchFocusedProvider, reloadFocusedAgent, rewindFocusedToPrompt } =
    useProviderActions(refs, setRuntimes, showPaneToast, sessionActions)

  const { loadOlderHistory } = useHistoryActions(setRuntimes, refs, updateRuntime)

  const { undoClose, undoCloseCount } = useUndoCloseAction(
    state,
    setState,
    refs,
    sessionActions,
  )

  // ---- Side-effects (subscriptions, persistence, invalidation) ----
  useIpcSubscriptions(refs, setState, setRuntimes, updateRuntime, appendFeedDebug)
  useAutoSave(state, draftVersion, refs)
  useBootstrap(refs, setState, setRuntimes, setTileTabs, tabActions.newTab as unknown as (cwd: string) => Promise<unknown>)
  useFeedDebugPersist(runtimes, refs)
  useSpotlightSanity(spotlight, state.tabs, setSpotlight)
  useReaderModeSanity(readerMode, state.tabs, setReaderMode)
  usePickerSanity(runtimes, pickerCancel)
  useTileTabsSanity(tileTabs, state.tabs, setTileTabs)

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
    toggleReaderMode,
    setReaderModeSession,
    latestScreenRef: refs.latestScreenRef,
    getRuntime,
    statusMode,
    toggleStatusMode,
    // actions
    newTab: tabActions.newTab,
    closeTab: tabActions.closeTab,
    spawn,
    killSession,
    splitFocused: paneActions.splitFocused,
    startNewAgentPlacement: paneActions.startNewAgentPlacement,
    commitNewAgentPlacement: paneActions.commitNewAgentPlacement,
    closeFocused: paneActions.closeFocused,
    closeSession: paneActions.closeSession,
    requestBuryFocused: paneActions.requestBuryFocused,
    buryFocused: paneActions.buryFocused,
    reviveBuried: paneActions.reviveBuried,
    focusSession: paneActions.focusSession,
    focusSessionInTab: paneActions.focusSessionInTab,
    navigate: paneActions.navigate,
    activateTab: tabActions.activateTab,
    activateTabByIndex: tabActions.activateTabByIndex,
    nextTab: tabActions.nextTab,
    prevTab: tabActions.prevTab,
    resizeFocused,
    resizeFocusedDirectional,
    setSplitRatio,
    setSplitRatioInTab,
    setStreamingBaseline,
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
    switchFocusedProvider,
    rewindFocusedToPrompt,
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
  }
}
