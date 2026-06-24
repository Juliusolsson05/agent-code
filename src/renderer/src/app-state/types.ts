import type { Settings } from '@renderer/app-state/settings/types'
import type { DispatchAttachIntent, UiShellState } from '@renderer/app-state/uiShell/types'
import type { SessionId, TabId } from '@renderer/workspace/types'
import type { WorkspaceState } from '@renderer/workspace/types'
import type {
  ReaderModeState,
  SessionRuntime,
  SpotlightState,
  TileTabsState,
} from '@renderer/workspace/workspaceState'

export type SettingsSlice = {
  settings: Settings
  setSettings: (patch: Partial<Settings>) => void
  resetSettings: () => void
  toggleCustomRendering: () => void
  toggleStatusMode: () => void
  toggleWorktreeBadges: () => void
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
  openReorderTabs: () => void
  closeReorderTabs: () => void
  openPinAgents: () => void
  closePinAgents: () => void
  openSettingsPage: () => void
  closeSettingsPage: () => void
  openBuryPrompt: (sessionId: SessionId) => void
  closeBuryPrompt: () => void
  openDebugBundleNotePrompt: (payload: {
    bundlePath: string
    sessionId: SessionId
    title: string
    description: string
  }) => void
  closeDebugBundleNotePrompt: () => void
  openViewPrompts: (sessionId: SessionId) => void
  closeViewPrompts: () => void
  openNewAgentPlacement: () => void
  closeNewAgentPlacement: () => void
  openTiledDispatchPrompt: () => void
  closeTiledDispatchPrompt: () => void
  openDispatchAttach: (intent: DispatchAttachIntent) => void
  closeDispatchAttach: () => void
  openLinkedAgent: (sessionId: SessionId) => void
  closeLinkedAgent: () => void
  toggleGitBar: () => void
  toggleWorktreesBar: () => void
  toggleDebugPanel: () => void
  toggleFeedDebugPanel: () => void
  toggleProxyDebugPanel: () => void
  toggleHtmlDebugPanel: () => void
  toggleDevDebugPanel: () => void
  openAgentStatusPanel: () => void
  closeAgentStatusPanel: () => void
  toggleAgentStatusPanel: () => void
  togglePerformancePanel: () => void
  openGlobalEditor: () => void
  closeGlobalEditor: () => void
  toggleGlobalEditor: () => void
  setDispatchListRatio: (ratio: number) => void
  openPromptSearch: () => void
  closePromptSearch: () => void
  openAgentActivity: () => void
  closeAgentActivity: () => void
  openCloseOldAgents: () => void
  closeCloseOldAgents: () => void
  openRewindPrompt: (sessionId: SessionId) => void
  closeRewindPrompt: () => void
}

export type WorkspaceSlice = {
  workspaceState: WorkspaceState
  workspaceRuntimes: Record<string, SessionRuntime>
  workspaceSpotlight: SpotlightState | null
  workspaceReaderMode: ReaderModeState | null
  workspaceTileTabs: TileTabsState | null
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
}

export type AppStore = SettingsSlice & UiShellSlice & WorkspaceSlice
