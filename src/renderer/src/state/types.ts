import type { Settings } from './settings/types'
import type { UiShellState } from './uiShell/types'
import type { SessionId, TabId } from '../tiles/types'
import type { WorkspaceState } from '../tiles/types'
import type {
  ReaderModeState,
  SessionRuntime,
  SpotlightState,
  TileTabsState,
} from '../tiles/workspaceState'

export type SettingsSlice = {
  settings: Settings
  setSettings: (patch: Partial<Settings>) => void
  resetSettings: () => void
  toggleCustomRendering: () => void
}

export type UiShellSlice = UiShellState & {
  openCommandPalette: () => void
  closeCommandPalette: () => void
  toggleCommandPalette: () => void
  openPathPicker: (defaultValue?: string) => void
  closePathPicker: () => void
  setPathPickerDefault: (value: string) => void
  openTileTabsModal: (initialSelectedIds: TabId[]) => void
  closeTileTabsModal: () => void
  openSettingsPage: () => void
  closeSettingsPage: () => void
  openBuryPrompt: (sessionId: SessionId) => void
  closeBuryPrompt: () => void
  openViewPrompts: (sessionId: SessionId) => void
  closeViewPrompts: () => void
  openNewAgentPlacement: () => void
  closeNewAgentPlacement: () => void
  toggleGitBar: () => void
  toggleDebugPanel: () => void
  toggleFeedDebugPanel: () => void
  toggleProxyDebugPanel: () => void
  toggleHtmlDebugPanel: () => void
  openPromptSearch: () => void
  closePromptSearch: () => void
  openAgentActivity: () => void
  closeAgentActivity: () => void
}

export type WorkspaceSlice = {
  workspaceState: WorkspaceState
  workspaceRuntimes: Record<string, SessionRuntime>
  workspaceSpotlight: SpotlightState | null
  workspaceReaderMode: ReaderModeState | null
  workspaceTileTabs: TileTabsState | null
  workspaceStatusMode: boolean
  setWorkspaceState: (
    next: WorkspaceState | ((prev: WorkspaceState) => WorkspaceState),
  ) => void
  setWorkspaceRuntimes: (
    next: Record<string, SessionRuntime>
      | ((prev: Record<string, SessionRuntime>) => Record<string, SessionRuntime>),
  ) => void
  setWorkspaceSpotlight: (
    next: SpotlightState | null | ((prev: SpotlightState | null) => SpotlightState | null),
  ) => void
  setWorkspaceReaderMode: (
    next: ReaderModeState | null | ((prev: ReaderModeState | null) => ReaderModeState | null),
  ) => void
  setWorkspaceTileTabs: (
    next: TileTabsState | null | ((prev: TileTabsState | null) => TileTabsState | null),
  ) => void
  setWorkspaceStatusMode: (next: boolean | ((prev: boolean) => boolean)) => void
}

export type AppStore = SettingsSlice & UiShellSlice & WorkspaceSlice
