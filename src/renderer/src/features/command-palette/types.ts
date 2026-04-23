import type { Workspace } from '../../workspace/workspaceStore'

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
    openSettings: () => void
    openViewPrompts: (sessionId: string) => void
    openPromptSearch: () => void
    openAgentActivity: () => void
    openRewindPrompt: (sessionId: string) => void
    toggleGitBar: () => void
    toggleDebugPanel: () => void
    toggleFeedDebugPanel: () => void
    toggleProxyDebugPanel: () => void
    toggleHtmlDebugPanel: () => void
    toggleCustomRendering: () => void
    setDangerousAgentsEnabled: (enabled: boolean) => void
    enterResumeMode: () => void
    enterBuriedMode: () => void
    closePalette: () => void
  }
  flags: {
    customRenderingEnabled: boolean
    dangerousAgentsEnabled: boolean
    gitBarOpen: boolean
    debugPanelOpen: boolean
    feedDebugPanelOpen: boolean
    proxyDebugPanelOpen: boolean
    htmlDebugPanelOpen: boolean
  }
}

export type CommandDef = {
  id: string
  title: string | ((ctx: CommandContext) => string)
  shortcut?: string
  keywords?: string[]
  when?: (ctx: CommandContext) => boolean
  getState?: (ctx: CommandContext) => CommandState | null
  run: (ctx: CommandContext) => void | Promise<void>
}

export type ResolvedCommand = {
  id: string
  title: string
  shortcut?: string
  keywords: string[]
  state: CommandState | null
  run: (ctx: CommandContext) => void | Promise<void>
}
