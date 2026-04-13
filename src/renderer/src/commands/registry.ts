import { layoutCommands } from '../features/workspace/commands/layoutCommands'
import { paneCommands } from '../features/workspace/commands/paneCommands'
import { sessionCommands } from '../features/workspace/commands/sessionCommands'
import { tabCommands } from '../features/workspace/commands/tabCommands'
import { settingsCommands } from '../features/settings/commands/settingsCommands'
import { spotlightCommands } from '../features/spotlight/commands/spotlightCommands'
import { tileTabsCommands } from '../features/tile-tabs/commands/tileTabsCommands'
import { readerCommands } from '../features/reader/commands/readerCommands'
import type { CommandContext, CommandDef, ResolvedCommand } from './types'

const commandDefs: CommandDef[] = [
  ...tabCommands,
  ...paneCommands,
  ...layoutCommands,
  ...sessionCommands,
  ...spotlightCommands,
  ...readerCommands,
  ...tileTabsCommands,
  ...settingsCommands,
]

export function buildCommandRegistry(ctx: CommandContext): ResolvedCommand[] {
  return commandDefs
    .filter(command => (command.when ? command.when(ctx) : true))
    .map(command => ({
      id: command.id,
      title: typeof command.title === 'function' ? command.title(ctx) : command.title,
      shortcut: command.shortcut,
      keywords: command.keywords ?? [],
      run: command.run,
    }))
}
