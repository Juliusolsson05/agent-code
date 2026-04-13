import type { Workspace } from '../tiles/workspaceStore'

export type CommandContext = {
  workspace: Workspace
  ui: {
    openNewTabPicker: () => void
    openResumePicker: (defaultCwd: string) => void
    openTileTabs: () => void
    openSettings: () => void
    toggleGitBar: () => void
    toggleDebugPanel: () => void
    toggleCustomRendering: () => void
    enterResumeMode: () => void
    enterBuriedMode: () => void
    closePalette: () => void
  }
  flags: {
    customRenderingEnabled: boolean
  }
}

export type CommandDef = {
  id: string
  title: string | ((ctx: CommandContext) => string)
  shortcut?: string
  keywords?: string[]
  when?: (ctx: CommandContext) => boolean
  run: (ctx: CommandContext) => void | Promise<void>
}

export type ResolvedCommand = {
  id: string
  title: string
  shortcut?: string
  keywords: string[]
  run: (ctx: CommandContext) => void | Promise<void>
}
