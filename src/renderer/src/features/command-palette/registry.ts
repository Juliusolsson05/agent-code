import { layoutCommands } from '@renderer/features/workspace/commands/layoutCommands'
import { paneCommands } from '@renderer/features/workspace/commands/paneCommands'
import { sessionCommands } from '@renderer/features/workspace/commands/sessionCommands'
import { tabCommands } from '@renderer/features/workspace/commands/tabCommands'
import { settingsCommands } from '@renderer/features/settings/commands/settingsCommands'
import { spotlightCommands } from '@renderer/features/spotlight/commands/spotlightCommands'
import { tileTabsCommands } from '@renderer/features/tile-tabs/commands/tileTabsCommands'
import { readerCommands } from '@renderer/features/reader/commands/readerCommands'
import { copyAssistantCommands } from '@renderer/features/copy-assistant/commands/copyAssistantCommands'
import type { CommandContext, CommandDef, ResolvedCommand } from '@renderer/features/command-palette/types'

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
