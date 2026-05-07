import type { Workspace } from '@renderer/workspace/workspaceStore'

export type CommandState = {
  label: string
  tone?: 'neutral' | 'accent' | 'danger'
}

export type CommandContext = {
  workspace: Workspace
  ui: {
    openNewTabPicker: () => void
    openResumePicker: (defaultCwd: string) => void
    openTileTabs: () => void
    openReorderTabs: () => void
    openSettings: () => void
    openViewPrompts: (sessionId: string) => void
    openPromptSearch: () => void
    openAgentActivity: () => void
    openRewindPrompt: (sessionId: string) => void
    toggleGitBar: () => void
    toggleWorktreesBar: () => void
    toggleDebugPanel: () => void
    toggleFeedDebugPanel: () => void
    toggleProxyDebugPanel: () => void
    toggleHtmlDebugPanel: () => void
    togglePerformancePanel: () => void
    enterDispatchMode: () => Promise<void> | void
    enterGlobalDispatch: () => Promise<void> | void
    exitDispatchMode: () => void
    toggleDispatchTerminal: () => Promise<void> | void
    /** Open the placement overlay in "attach detached session to grid"
     *  mode for the given sessionId. The session must exist in
     *  workspace.state.detachedSessions; the command's `when` guard is
     *  responsible for that check. */
    openDispatchAttach: (sessionId: string) => void
    toggleCustomRendering: () => void
    toggleStatusMode: () => void
    toggleWorktreeBadges: () => void
    setDangerousAgentsEnabled: (enabled: boolean) => void
    setAggressiveDebugPersistence: (enabled: boolean) => void
    enterResumeMode: () => void
    enterBuriedMode: () => void
    enterKillBuriedMode: () => void
    enterPromptTemplateMode: () => void
    enterSavePromptTemplateMode: () => void
    closePalette: () => void
  }
  flags: {
    customRenderingEnabled: boolean
    statusModeEnabled: boolean
    worktreeBadgesEnabled: boolean
    dangerousAgentsEnabled: boolean
    aggressiveDebugPersistenceEnabled: boolean
    gitBarOpen: boolean
    worktreesBarOpen: boolean
    debugPanelOpen: boolean
    feedDebugPanelOpen: boolean
    proxyDebugPanelOpen: boolean
    htmlDebugPanelOpen: boolean
    performancePanelOpen: boolean
    dispatchModeEnabled: boolean
    globalDispatchEnabled: boolean
    dispatchTerminalVisible: boolean
  }
}

export type CommandDef = {
  id: string
  title: string | ((ctx: CommandContext) => string)
  description: string
  shortcut?: string
  keywords?: string[]
  keepPaletteOpen?: boolean
  when?: (ctx: CommandContext) => boolean
  getState?: (ctx: CommandContext) => CommandState | null
  run: (ctx: CommandContext) => void | Promise<void>
}

export type ResolvedCommand = {
  id: string
  title: string
  description: string
  shortcut?: string
  keywords: string[]
  keepPaletteOpen: boolean
  state: CommandState | null
  run: (ctx: CommandContext) => void | Promise<void>
}
