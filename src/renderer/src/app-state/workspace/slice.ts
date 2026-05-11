import type { StateCreator } from 'zustand'

import type { AppStore, WorkspaceSlice } from '@renderer/app-state/types'
import type { WorkspaceState } from '@renderer/workspace/types'
import type {
  ReaderModeState,
  SessionRuntime,
  SpotlightState,
  TileTabsState,
} from '@renderer/workspace/workspaceState'

function applyUpdater<T>(prev: T, next: T | ((prev: T) => T)): T {
  return typeof next === 'function'
    ? (next as (prev: T) => T)(prev)
    : next
}

const initialWorkspaceState: WorkspaceState = {
  tabs: [],
  activeTabId: '',
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
    set(state => ({
      workspaceState: applyUpdater<WorkspaceState>(state.workspaceState, next),
    }), false, 'workspace/setWorkspaceState'),

  setWorkspaceRuntimes: next =>
    set(state => ({
      workspaceRuntimes: applyUpdater<Record<string, SessionRuntime>>(state.workspaceRuntimes, next),
    }), false, 'workspace/setWorkspaceRuntimes'),

  setWorkspaceSpotlight: next =>
    set(state => ({
      workspaceSpotlight: applyUpdater<SpotlightState | null>(state.workspaceSpotlight, next),
    }), false, 'workspace/setWorkspaceSpotlight'),

  setWorkspaceReaderMode: next =>
    set(state => ({
      workspaceReaderMode: applyUpdater<ReaderModeState | null>(state.workspaceReaderMode, next),
    }), false, 'workspace/setWorkspaceReaderMode'),

  setWorkspaceTileTabs: next =>
    set(state => ({
      workspaceTileTabs: applyUpdater<TileTabsState | null>(state.workspaceTileTabs, next),
    }), false, 'workspace/setWorkspaceTileTabs'),
})
