import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import type { CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { Workspace } from '@renderer/workspace/workspaceStore'

function focusedAgentSessionId(workspace: Workspace): string | null {
  const sessionId = commandTargetSessionId(workspace)
  if (!sessionId) return null
  const kind = workspace.state.sessions[sessionId]?.kind ?? DEFAULT_PROVIDER
  return kind === 'terminal' ? null : sessionId
}

export const promptTemplateCommands: CommandDef[] = [
  {
    id: 'manage-prompt-templates',
    category: 'workspace-tools',
    pickerVisibility: 'advanced',
    surface: 'app',
    title: 'Manage Prompt Templates…',
    description: '**What it does:** Opens the **prompt template manager** for creating, editing, duplicating, and deleting reusable prompts.\n\n**Use when:** You want to organize or author custom templates.\n\n**Notes:** Built-ins stay read-only; duplicate them to customize.',
    keywords: ['prompt', 'template', 'manage', 'custom', 'variables', 'snippets'],
    keepPaletteOpen: true,
    run: ({ ui, flags }) => {
      // Already showing this mode? Dismiss. A mode-entering command whose
      // second press re-enters the mode it is already in reads as a dead key,
      // which is the same complaint that started this whole change.
      if (flags.paletteMode === 'manage-prompt-template') {
        ui.closePalette()
        return
      }
      ui.enterManagePromptTemplateMode()
    },
  },
  {
    id: 'prompt-template',
    category: 'session',
    surface: 'session',
    title: 'Prompt Template…',
    description: '**What it does:** Inserts a saved **prompt template** into the focused composer.\n\n**Use when:** You want reusable prompt text without retyping it.\n\n**Notes:** Agent panes only.',
    keywords: ['prompt', 'template', 'snippet', 'insert', 'draft'],
    keepPaletteOpen: true,
    renderedViewPolicy: { kind: 'opens-rendered-feed' },
    when: ({ workspace }) => focusedAgentSessionId(workspace) !== null,
    run: ({ ui, flags }) => {
      // Already showing this mode? Dismiss. A mode-entering command whose
      // second press re-enters the mode it is already in reads as a dead key,
      // which is the same complaint that started this whole change.
      if (flags.paletteMode === 'prompt-template') {
        ui.closePalette()
        return
      }
      ui.enterPromptTemplateMode()
    },
  },
  {
    id: 'save-composer-as-prompt-template',
    category: 'workspace-tools',
    pickerVisibility: 'advanced',
    surface: 'session',
    title: 'Save Composer as Prompt Template…',
    description: '**What it does:** Saves current composer text as a **custom prompt template**.\n\n**Use when:** You wrote a prompt you expect to reuse.\n\n**Notes:** Only appears when the composer has text.',
    keywords: ['prompt', 'template', 'save', 'composer', 'custom', 'snippet'],
    keepPaletteOpen: true,
    renderedViewPolicy: { kind: 'requires-rendered-feed' },
    when: ({ workspace }) => {
      const sessionId = focusedAgentSessionId(workspace)
      if (!sessionId) return false
      return workspace.getRuntime(sessionId).draftInput.trim().length > 0
    },
    run: ({ workspace, ui, flags }) => {
      // Already showing this mode? Dismiss. A mode-entering command whose
      // second press re-enters the mode it is already in reads as a dead key,
      // which is the same complaint that started this whole change.
      if (flags.paletteMode === 'save-prompt-template') {
        ui.closePalette()
        return
      }
      const sessionId = focusedAgentSessionId(workspace)
      if (!sessionId) return
      ui.enterSavePromptTemplateMode()
    },
  },
]
