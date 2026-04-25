import type { CommandDef } from '@renderer/features/command-palette/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

function focusedAgentSessionId(workspace: Workspace): string | null {
  const tab = workspace.activeTab
  if (!tab) return null
  const kind = workspace.state.sessions[tab.focusedSessionId]?.kind ?? 'claude'
  return kind === 'terminal' ? null : tab.focusedSessionId
}

export const promptTemplateCommands: CommandDef[] = [
  {
    id: 'prompt-template',
    title: 'Prompt Template…',
    keywords: ['prompt', 'template', 'snippet', 'insert', 'draft'],
    keepPaletteOpen: true,
    when: ({ workspace }) => focusedAgentSessionId(workspace) !== null,
    run: ({ ui }) => ui.enterPromptTemplateMode(),
  },
  {
    id: 'save-composer-as-prompt-template',
    title: 'Save Composer as Prompt Template…',
    keywords: ['prompt', 'template', 'save', 'composer', 'custom', 'snippet'],
    keepPaletteOpen: true,
    when: ({ workspace }) => {
      const sessionId = focusedAgentSessionId(workspace)
      if (!sessionId) return false
      return workspace.getRuntime(sessionId).draftInput.trim().length > 0
    },
    run: ({ workspace, ui }) => {
      const sessionId = focusedAgentSessionId(workspace)
      if (!sessionId) return
      ui.enterSavePromptTemplateMode()
    },
  },
]
