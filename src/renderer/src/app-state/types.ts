import type { PaletteMode } from '@renderer/features/command-palette/paletteMode'
import type { Settings } from '@renderer/app-state/settings/types'
import type {
  DispatchAttachIntent,
  PendingCommandInvocation,
  UiShellState,
} from '@renderer/app-state/uiShell/types'
import type { SessionId, TabId } from '@renderer/workspace/types'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type {
  ReaderModeState,
  SpotlightState,
  TileTabsState,
} from '@renderer/workspace/types'

import type { ColorFlagId } from '@renderer/app-state/settings/dispatchColorFlags'

export type SettingsSlice = {
  settings: Settings
  setSettings: (patch: Partial<Settings>) => void
  resetSettings: () => void
  setDispatchColorFlag: (sessionId: string, colorId: ColorFlagId | null) => void
  toggleStatusMode: () => void
  toggleWorktreeBadges: () => void
  toggleUsageHeader: () => void
  cycleUsageHeaderLevel: () => void
}

export type UiShellSlice = UiShellState & {
  /**
   * Ask for a command to run through the shared execution gateway.
   *
   * Used by the native-menu bridge and the keybinding router. Both need a live
   * CommandContext they cannot cheaply build themselves, so they record the id
   * here and the palette — which owns the context — dispatches it.
   */
  requestCommandInvocation: (id: string, source: PendingCommandInvocation['source']) => void
  clearCommandInvocation: () => void
  openCommandPalette: () => void
  closeCommandPalette: () => void
  toggleCommandPalette: () => void
  /** Enter a palette sub-mode and make the palette visible. */
  setPaletteMode: (mode: PaletteMode) => void
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
  openRecordingNotePrompt: (payload: {
    sessionId: SessionId
    noteId: string
    title: string
  }) => void
  closeRecordingNotePrompt: () => void
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
  toggleRenderingDebugMode: () => void
  /** Flip workspace-wide feed auto-follow. See `tailAllMode` in
   *  app-state/uiShell/types.ts for why this is an OR-mask rather than a bulk
   *  write over every session's `tailMode`. */
  toggleTailAllMode: () => void
  toggleDevDebugPanel: () => void
  openAgentStatusPanel: () => void
  closeAgentStatusPanel: () => void
  toggleAgentStatusPanel: () => void
  togglePerformancePanel: () => void
  toggleRemotePanel: () => void
  openGlobalEditor: () => void
  closeGlobalEditor: () => void
  toggleGlobalEditor: () => void
  setDispatchListRatio: (ratio: number) => void
  openPromptSearch: () => void
  closePromptSearch: () => void
  openAgentActivity: () => void
  closeAgentActivity: () => void
  openKeyboardShortcuts: () => void
  closeKeyboardShortcuts: () => void
  openCloseOldAgents: () => void
  closeCloseOldAgents: () => void
  openBulkProviderSwitch: () => void
  closeBulkProviderSwitch: () => void
  openUsageModal: () => void
  closeUsageModal: () => void
  openRewindPrompt: (sessionId: SessionId) => void
  closeRewindPrompt: () => void
  openAgentViewModePicker: (sessionId: SessionId) => void
  closeAgentViewModePicker: () => void
  openColorFlagPicker: (sessionId: SessionId) => void
  closeColorFlagPicker: () => void
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
