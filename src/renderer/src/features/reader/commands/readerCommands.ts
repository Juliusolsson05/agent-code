import type { CommandDef } from '../../../commands/types'

// Reader Mode commands. Single toggle for now — enter/exit mirrors
// the spotlight family and uses the workspace's own toggle state.
//
// Title is dynamic so the command palette label flips between
// "Enter Reader Mode" and "Exit Reader Mode" based on current
// state. Same pattern as Spotlight.
export const readerCommands: CommandDef[] = [
  {
    id: 'toggle-reader-mode',
    title: ({ workspace }) =>
      workspace.readerMode ? 'Exit Reader Mode' : 'Reader Mode',
    keywords: ['reader', 'read', 'focus', 'plan', 'response', 'zen'],
    run: ({ workspace }) => workspace.toggleReaderMode(),
  },
]
