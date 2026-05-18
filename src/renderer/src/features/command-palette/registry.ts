import { layoutCommands } from '@renderer/features/workspace/commands/layoutCommands'
import { paneCommands } from '@renderer/features/workspace/commands/paneCommands'
import { sessionCommands } from '@renderer/features/workspace/commands/sessionCommands'
import { tabCommands } from '@renderer/features/workspace/commands/tabCommands'
import { settingsCommands } from '@renderer/features/settings/commands/settingsCommands'
import { spotlightCommands } from '@renderer/features/spotlight/commands/spotlightCommands'
import { tileTabsCommands } from '@renderer/features/tile-tabs/commands/tileTabsCommands'
import { readerCommands } from '@renderer/features/reader/commands/readerCommands'
import { copyAssistantCommands } from '@renderer/features/copy-assistant/commands/copyAssistantCommands'
import { copyCodeBlockCommands } from '@renderer/features/copy-code-block/commands/copyCodeBlockCommands'
import { promptTemplateCommands } from '@renderer/features/prompt-templates/commands/promptTemplateCommands'
import { agentStatusCommands } from '@renderer/features/agent-status/commands/agentStatusCommands'
import type {
  CommandContext,
  CommandDef,
  CommandSurface,
  ResolvedCommand,
} from '@renderer/features/command-palette/types'

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
  ...copyCodeBlockCommands,
  ...promptTemplateCommands,
  ...agentStatusCommands,
]

/**
 * Mode gate applied BEFORE each command's own `when`.
 *
 * This is the one place the surface→mode policy lives. `grid` commands
 * are meaningless or silent no-ops while Dispatch Mode owns the layout
 * (they target `tab.root` grid focus); `dispatch` commands have nothing
 * to act on outside Dispatch. Everything else — `app`, `session`,
 * `editor`, `debug` — is mode-independent and reaches its own `when`.
 *
 * Putting the gate here, not in 13 separate `when` closures, is the
 * point of issue #228: a command's module no longer has to remember to
 * re-implement "...and hide me in the wrong mode." It declares a
 * surface; the registry enforces it uniformly.
 */
function surfaceAvailable(surface: CommandSurface, ctx: CommandContext): boolean {
  if (surface === 'grid') return !ctx.flags.dispatchModeEnabled
  if (surface === 'dispatch') return ctx.flags.dispatchModeEnabled
  return true
}

export function buildCommandRegistry(ctx: CommandContext): ResolvedCommand[] {
  return commandDefs
    .filter(
      command =>
        surfaceAvailable(command.surface, ctx) &&
        (command.when ? command.when(ctx) : true),
    )
    .map(command => {
      const description = command.description.trim()
      if (!description) {
        throw new Error(`Command ${command.id} is missing a description`)
      }
      return {
        id: command.id,
        title: typeof command.title === 'function' ? command.title(ctx) : command.title,
        description,
        surface: command.surface,
        shortcut: command.shortcut,
        keywords: command.keywords ?? [],
        keepPaletteOpen: command.keepPaletteOpen === true,
        state: command.getState ? command.getState(ctx) : null,
        run: command.run,
      }
    })
}
