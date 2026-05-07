import type { CommandDef } from '@renderer/features/command-palette/types'

export const tileTabsCommands: CommandDef[] = [
  {
    id: 'tiled-tabs',
    title: 'Tiled Tabs',
    description: '**What it does:** Shows selected tabs in a **tiled tab view**.\n\n**Use when:** You want multiple tabs visible at once.\n\n**Notes:** Run it again to close the tiled view.',
    getState: ({ workspace }) => ({
      label: workspace.tileTabs ? 'On' : 'Off',
      tone: workspace.tileTabs ? 'accent' : 'neutral',
    }),
    run: ({ workspace, ui }) => {
      if (workspace.tileTabs) {
        workspace.closeTileTabs()
        return
      }
      ui.openTileTabs()
    },
  },
]
