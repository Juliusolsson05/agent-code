import type { CommandDef } from '../../command-palette/types'

export const readerCommands: CommandDef[] = [
  {
    id: 'toggle-reader-mode',
    title: 'Reader Mode',
    keywords: ['reader', 'read', 'focus', 'plan', 'response', 'zen'],
    getState: ({ workspace }) => ({
      label: workspace.readerMode ? 'On' : 'Off',
      tone: workspace.readerMode ? 'accent' : 'neutral',
    }),
    run: ({ workspace }) => workspace.toggleReaderMode(),
  },
]
