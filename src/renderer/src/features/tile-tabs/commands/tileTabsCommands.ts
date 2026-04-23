import type { CommandDef } from '@renderer/features/command-palette/types'

export const tileTabsCommands: CommandDef[] = [
  {
    id: 'tiled-tabs',
    title: 'Tiled Tabs',
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
