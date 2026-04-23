import type { CommandDef } from '../../command-palette/types'

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
    keywords: ['copy', 'assistant', 'message', 'response', 'pick'],
    when: ({ workspace }) => workspace.activeTab !== null,
    run: ({ workspace }) => {
      const tab = workspace.activeTab
      if (!tab) return
      workspace.pickerEnter(tab.focusedSessionId)
    },
  },
]
