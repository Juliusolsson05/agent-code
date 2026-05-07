import type { CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { Workspace } from '@renderer/workspace/workspaceStore'

function focusedAgentSessionId(workspace: Workspace): string | null {
  const sessionId = commandTargetSessionId(workspace)
  if (!sessionId) return null
  const kind = workspace.state.sessions[sessionId]?.kind ?? 'claude'
  return kind === 'terminal' ? null : sessionId
}

export const promptTemplateCommands: CommandDef[] = [
  {
    id: 'prompt-template',
    title: 'Prompt Template…',
    description: '**What it does:** Inserts a saved **prompt template** into the focused composer.\n\n**Use when:** You want reusable prompt text without retyping it.\n\n**Notes:** Agent panes only.',
    keywords: ['prompt', 'template', 'snippet', 'insert', 'draft'],
    keepPaletteOpen: true,
    when: ({ workspace }) => focusedAgentSessionId(workspace) !== null,
    run: ({ ui }) => ui.enterPromptTemplateMode(),
  },
  {
    id: 'save-composer-as-prompt-template',
    title: 'Save Composer as Prompt Template…',
    description: '**What it does:** Saves current composer text as a **custom prompt template**.\n\n**Use when:** You wrote a prompt you expect to reuse.\n\n**Notes:** Only appears when the composer has text.',
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
