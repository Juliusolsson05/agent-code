import type { StateCreator } from 'zustand'

import type { AppStore, WorkspaceSlice } from '@renderer/app-state/types'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type {
  ReaderModeState,
  SpotlightState,
  TileTabsState,
} from '@renderer/workspace/types'

function applyUpdater<T>(prev: T, next: T | ((prev: T) => T)): T {
  return typeof next === 'function'
    ? (next as (prev: T) => T)(prev)
    : next
}

const initialWorkspaceState: WorkspaceState = {
  tabs: [],
  activeTabId: '',
  gridRelatedSelections: {},
  dispatchMode: null,
  sessions: {},
  detachedSessions: {},
  buried: [],
  // Fresh workspace has no pins. The array is the source of truth
  // for order: index 0 is the topmost pin in the Pinned section.
  pinnedSessionIds: [],
}

export const createWorkspaceSlice: StateCreator<
  AppStore,
  [['zustand/devtools', never], ['zustand/subscribeWithSelector', never]],
  [],
  WorkspaceSlice
> = set => ({
  workspaceState: initialWorkspaceState,
  workspaceRuntimes: {},
  workspaceSpotlight: null,
  workspaceReaderMode: null,
  workspaceTileTabs: null,

  setWorkspaceState: next =>
    set(state => {
      const workspaceState = applyUpdater<WorkspaceState>(state.workspaceState, next)
      // Returning a fresh partial object defeats Zustand's root Object.is
      // bailout even when the slice updater deliberately returned `prev`.
      // These five setters carry high-frequency IPC updates; preserve that
      // no-op signal before notifying every React selector in the application.
      return Object.is(workspaceState, state.workspaceState) ? state : { workspaceState }
    }, false, 'workspace/setWorkspaceState'),

  setWorkspaceRuntimes: next =>
    set(state => {
      const workspaceRuntimes = applyUpdater<Record<string, SessionRuntime>>(state.workspaceRuntimes, next)
      return Object.is(workspaceRuntimes, state.workspaceRuntimes) ? state : { workspaceRuntimes }
    }, false, 'workspace/setWorkspaceRuntimes'),

  setWorkspaceSpotlight: next =>
    set(state => {
      const workspaceSpotlight = applyUpdater<SpotlightState | null>(state.workspaceSpotlight, next)
      return Object.is(workspaceSpotlight, state.workspaceSpotlight) ? state : { workspaceSpotlight }
    }, false, 'workspace/setWorkspaceSpotlight'),

  setWorkspaceReaderMode: next =>
    set(state => {
      const workspaceReaderMode = applyUpdater<ReaderModeState | null>(state.workspaceReaderMode, next)
      return Object.is(workspaceReaderMode, state.workspaceReaderMode) ? state : { workspaceReaderMode }
    }, false, 'workspace/setWorkspaceReaderMode'),

  setWorkspaceTileTabs: next =>
    set(state => {
      const workspaceTileTabs = applyUpdater<TileTabsState | null>(state.workspaceTileTabs, next)
      return Object.is(workspaceTileTabs, state.workspaceTileTabs) ? state : { workspaceTileTabs }
    }, false, 'workspace/setWorkspaceTileTabs'),
})
