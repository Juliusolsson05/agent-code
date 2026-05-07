import type { CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

// "Copy Assistant Message" — opens the picker on the focused pane.
// All navigation (Up/Down/Enter/Esc) is handled by useKeybinds when
// the runtime's assistantPicker is non-null. The command itself only
// toggles entry — it does NOT copy directly. Distinct from
// "Copy Last Response" (paneCommands.ts), which copies the most-
// recent assistant message immediately with no picker.
export const copyAssistantCommands: CommandDef[] = [
  {
    id: 'copy-assistant-message',
    title: 'Copy Assistant Message…',
    description: '**What it does:** Opens a picker to copy a specific **assistant message**.\n\n**Use when:** You need an older response, not just the latest one.\n\n**Notes:** Use arrows, **Enter**, and **Esc** after opening.',
    keywords: ['copy', 'assistant', 'message', 'response', 'pick'],
    when: ({ workspace }) => commandTargetSessionId(workspace) !== null,
    run: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      if (!sessionId) return
      workspace.pickerEnter(sessionId)
    },
  },
]
