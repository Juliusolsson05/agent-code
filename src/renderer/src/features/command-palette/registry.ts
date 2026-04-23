import { layoutCommands } from '../workspace/commands/layoutCommands'
import { paneCommands } from '../workspace/commands/paneCommands'
import { sessionCommands } from '../workspace/commands/sessionCommands'
import { tabCommands } from '../workspace/commands/tabCommands'
import { settingsCommands } from '../settings/commands/settingsCommands'
import { spotlightCommands } from '../spotlight/commands/spotlightCommands'
import { tileTabsCommands } from '../tile-tabs/commands/tileTabsCommands'
import { readerCommands } from '../reader/commands/readerCommands'
import { copyAssistantCommands } from '../copy-assistant/commands/copyAssistantCommands'
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
  ...copyAssistantCommands,
]

export function buildCommandRegistry(ctx: CommandContext): ResolvedCommand[] {
  return commandDefs
    .filter(command => (command.when ? command.when(ctx) : true))
    .map(command => ({
      id: command.id,
      title: typeof command.title === 'function' ? command.title(ctx) : command.title,
      shortcut: command.shortcut,
      keywords: command.keywords ?? [],
      state: command.getState ? command.getState(ctx) : null,
      run: command.run,
    }))
}
