import type { CommandDef } from '@renderer/features/command-palette/types'
import { saveCustomPromptTemplate } from '@renderer/features/prompt-templates/templates'
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
    when: ({ workspace }) => focusedAgentSessionId(workspace) !== null,
    run: ({ ui }) => ui.enterPromptTemplateMode(),
  },
  {
    id: 'save-composer-as-prompt-template',
    title: 'Save Composer as Prompt Template…',
    keywords: ['prompt', 'template', 'save', 'composer', 'custom', 'snippet'],
    when: ({ workspace }) => {
      const sessionId = focusedAgentSessionId(workspace)
      if (!sessionId) return false
      return workspace.getRuntime(sessionId).draftInput.trim().length > 0
    },
    run: ({ workspace, ui }) => {
      const sessionId = focusedAgentSessionId(workspace)
      if (!sessionId) return

      const draft = workspace.getRuntime(sessionId).draftInput.trim()
      if (!draft) return

      // This is intentionally the smallest possible custom-template UI
      // for the first pass. The composer is already the full-featured
      // multiline editor; this command treats its current contents as
      // the body and only asks for a title. A later Manage Templates
      // modal can edit/delete records without changing the storage
      // shape introduced here.
      const title = window.prompt('Template name')
      if (!title?.trim()) return
      const template = saveCustomPromptTemplate(title, draft)
      ui.closePalette()
      workspace.showPaneToast(sessionId, `Saved prompt template: ${template.title}`)
    },
  },
]
