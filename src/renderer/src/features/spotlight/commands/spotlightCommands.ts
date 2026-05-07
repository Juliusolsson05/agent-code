import type { CommandDef } from '@renderer/features/command-palette/types'

export const spotlightCommands: CommandDef[] = [
  {
    id: 'toggle-spotlight',
    title: 'Spotlight',
    description: '**What it does:** Toggles a focused **single-pane view**.\n\n**Use when:** You want one session large without changing the grid layout.\n\n**Notes:** Press **Esc** to exit.',
    getState: ({ workspace }) => ({
      label: workspace.spotlight ? 'On' : 'Off',
      tone: workspace.spotlight ? 'accent' : 'neutral',
    }),
    run: ({ workspace }) => workspace.toggleSpotlight(),
  },
]
