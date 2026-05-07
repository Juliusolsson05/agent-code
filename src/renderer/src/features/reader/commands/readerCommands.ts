import type { CommandDef } from '@renderer/features/command-palette/types'

export const readerCommands: CommandDef[] = [
  {
    id: 'toggle-reader-mode',
    title: 'Reader Mode',
    description: '**What it does:** Toggles a cleaner **reading view** for the current agent.\n\n**Use when:** You want to read long agent output comfortably.\n\n**Notes:** Uses the focused command target.',
    keywords: ['reader', 'read', 'focus', 'plan', 'response', 'zen'],
    getState: ({ workspace }) => ({
      label: workspace.readerMode ? 'On' : 'Off',
      tone: workspace.readerMode ? 'accent' : 'neutral',
    }),
    run: ({ workspace }) => workspace.toggleReaderMode(),
  },
]
