import type { CommandDef } from '@renderer/features/command-palette/types'

export const usageCommands: CommandDef[] = [
  {
    id: 'usage.open',
    title: 'Usage',
    description: 'Open provider usage for Claude and Codex.',
    surface: 'app',
    keywords: ['quota', 'tokens', 'limits', 'claude', 'codex'],
    run: ({ ui }) => {
      ui.openUsageModal()
      ui.closePalette()
    },
  },
]
