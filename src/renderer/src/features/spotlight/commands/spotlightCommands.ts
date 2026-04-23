import type { CommandDef } from '../../command-palette/types'

export const spotlightCommands: CommandDef[] = [
  {
    id: 'toggle-spotlight',
    title: 'Spotlight',
    getState: ({ workspace }) => ({
      label: workspace.spotlight ? 'On' : 'Off',
      tone: workspace.spotlight ? 'accent' : 'neutral',
    }),
    run: ({ workspace }) => workspace.toggleSpotlight(),
  },
]
