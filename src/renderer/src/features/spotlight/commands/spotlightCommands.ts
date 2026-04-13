import type { CommandDef } from '../../../commands/types'

export const spotlightCommands: CommandDef[] = [
  {
    id: 'toggle-spotlight',
    title: 'Toggle Spotlight',
    run: ({ workspace }) => workspace.toggleSpotlight(),
  },
]
