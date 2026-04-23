import type { StateCreator } from 'zustand'

import type { AppStore, WorkspaceSlice } from '../types'
import type { WorkspaceState } from '../../workspace/types'
import type {
  ReaderModeState,
  SessionRuntime,
  SpotlightState,
  TileTabsState,
} from '../../workspace/workspaceState'

function applyUpdater<T>(prev: T, next: T | ((prev: T) => T)): T {
  return typeof next === 'function'
    ? (next as (prev: T) => T)(prev)
    : next
}

const initialWorkspaceState: WorkspaceState = {
  tabs: [],
  activeTabId: '',
  sessions: {},
  buried: [],
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
  workspaceStatusMode: false,

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

  setWorkspaceStatusMode: next =>
    set(state => ({
      workspaceStatusMode: applyUpdater<boolean>(state.workspaceStatusMode, next),
    }), false, 'workspace/setWorkspaceStatusMode'),
})
