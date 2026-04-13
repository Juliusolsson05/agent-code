import type { CommandDef } from '../../../commands/types'

export const tileTabsCommands: CommandDef[] = [
  {
    id: 'tile-tabs',
    title: 'Tile Tabs',
    run: ({ ui }) => ui.openTileTabs(),
  },
  {
    id: 'exit-tiled-tabs',
    title: 'Exit Tiled Tabs',
    when: ({ workspace }) => workspace.tileTabs !== null,
    run: ({ workspace }) => workspace.closeTileTabs(),
  },
]
