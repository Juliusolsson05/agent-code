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
    toggleDevDebugPanel: () => void
    togglePerformancePanel: () => void
    toggleGlobalEditor: () => void
    /** Toggle visibility of the Global Editor's in-editor file tree.
     *  Only meaningful when the overlay is open — the command's
     *  `when` guard enforces that. The flag lives on the
     *  global-editor store (not uiShell) because it's editor-scoped
     *  state, not workspace chrome. */
    toggleFileTreeVisible: () => void
    enterDispatchMode: () => Promise<void> | void
    enterGlobalDispatch: () => Promise<void> | void
    exitDispatchMode: () => void
    /** Open the placement overlay in "attach detached session to grid"
     *  mode for the given sessionId. The session must exist in
     *  workspace.state.detachedSessions; the command's `when` guard is
     *  responsible for that check. */
    openDispatchAttach: (sessionId: string) => void
    /** Open the Pin Agents multi-select modal. Lives on uiShell as a
     *  transient flag — the draft selection state is owned by the
     *  modal itself, not the store. */
    openPinAgents: () => void
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
    devDebugEnabled: boolean
    devDebugPanelOpen: boolean
    performancePanelOpen: boolean
    globalEditorOpen: boolean
    /** Whether the Global Editor's in-editor file tree is rendered.
     *  Only consulted while the overlay is open; otherwise it has no
     *  visible effect. Source of truth is the global-editor store. */
    fileTreeVisible: boolean
    dispatchModeEnabled: boolean
    globalDispatchEnabled: boolean
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
