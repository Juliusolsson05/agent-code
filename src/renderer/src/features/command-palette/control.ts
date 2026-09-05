import { commandExecutionRequests, CommandExecutionBusy, CommandExecutionTimeout } from './commandExecutionRequests'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { z } from 'zod'
import { ControlError, defineCapability, pageInput, pageSchema, paginate } from '@control-sdk'
import { builtInCommandCatalog } from './catalog'
import { PALETTE_SELF_EXCLUDED_COMMAND_IDS } from './commands/paletteCommands'
import { commandSearchFields } from './lib/rankCommands'
import { rankEntries } from './lib/rankEntries'
import { declaredTier, isVisibleInPicker } from './pickerVisibility'
import { useAppStore } from '@renderer/app-state/store'
import { buildDefaultKeybindings } from '@renderer/features/command-keybindings/defaults'
import { resolveEffectiveKeybindings } from '@renderer/features/command-keybindings/resolve'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import { paletteRequests } from './paletteRequests'

const commandSchema = z.object({
  id: z.string(), title: z.string(), titleRequiresContext: z.boolean(), description: z.string(),
  keywords: z.array(z.string()), category: z.string(), surface: z.string(), risk: z.string(),
  pickerTier: z.string(), visibleInPicker: z.boolean(), bindings: z.array(z.string()),
  route: z.enum(['command-picker', 'keybinding-or-menu']), availability: z.literal('checked-on-invocation'),
})

export function commandReference() {
  const { settings } = useAppStore.getState()
  const bindings = new Map(resolveEffectiveKeybindings(settings.commandKeybindingOverrides, buildDefaultKeybindings()).map(entry => [entry.commandId, [...entry.bindings]]))
  // Membership comes from the unfiltered catalog, not today's visible picker.
  // Do not mount CommandPalette or call getState/when/run closures just to list
  // commands. Contextual admission is checked when the user invokes a command.
  return builtInCommandCatalog.map(command => ({
    id: command.id, title: typeof command.title === 'string' ? command.title : command.id,
    titleRequiresContext: typeof command.title !== 'string', description: command.description,
    keywords: command.keywords ?? [], category: command.category ?? 'uncategorized',
    surface: command.surface, risk: command.risk ?? 'safe', pickerTier: declaredTier(command),
    visibleInPicker: !PALETTE_SELF_EXCLUDED_COMMAND_IDS.has(command.id) && isVisibleInPicker(command, {
      overrides: settings.commandVisibilityOverrides, showHiddenCommands: false,
      navigationCommandsEnabled: settings.navigationCommandsEnabled,
    }),
    bindings: bindings.get(command.id) ?? [],
    route: PALETTE_SELF_EXCLUDED_COMMAND_IDS.has(command.id) ? 'keybinding-or-menu' as const : 'command-picker' as const,
    availability: 'checked-on-invocation' as const,
  }))
}

export function commandControlCapabilities() {
  return [
    defineCapability({
      id: 'commands.run', title: 'Run an app command', execution: 'window', effect: 'mutation', completion: 'accepted',
      description: 'Invoke an exact command through the same contextual dispatcher as the menu and shortcuts. Use a dedicated tool when available; this route operates on the selected context in the chosen window. Pass expectedSessionId for agent-specific commands to reject selection changes. A ran result means the command dispatcher returned; dialogs, background tasks and provider work may still be pending. Observe the app afterward. Hidden commands remain callable when applicable; blocking surfaces are respected.',
      input: z.object({ commandId: z.string().describe('Exact ID from commands.list, not the MCP tool name or command title.'),
        expectedSessionId: z.string().optional().describe('For an agent-specific command, the selected agent you observed; rejects another agent becoming selected before dispatch.') }).strict(),
      output: z.object({ commandId: z.string(), dispatch: z.literal('ran'), selectedSessionId: z.string().nullable(), commandPickerOpen: z.boolean(), settingsOpen: z.boolean() }),
      handler: async input => {
        if (!builtInCommandCatalog.some(command => command.id === input.commandId)) throw new ControlError('unavailable', 'Unknown command; search commands.list')
        try {
          const result = await commandExecutionRequests.request(input)
          if (result.status !== 'ran') throw new ControlError(result.status === 'failed' ? 'failed' : 'unavailable',
            result.status === 'unavailable' ? result.reason : result.status === 'failed' ? String(result.error) : `Command ${result.status}; inspect the current UI`,
            result.status === 'failed' ? 'unknown' : 'not_started')
          const store = useAppStore.getState()
          return { commandId: result.id, dispatch: 'ran' as const, selectedSessionId: commandTargetSessionIdForState(store.workspaceState),
            commandPickerOpen: store.commandPaletteOpen, settingsOpen: store.settingsPageOpen }
        } catch (error) {
          if (error instanceof CommandExecutionBusy) throw new ControlError('unavailable', error.message)
          if (error instanceof CommandExecutionTimeout) throw new ControlError('unavailable', error.message, error.started ? 'unknown' : 'not_started')
          throw error
        }
      },
    }),
    defineCapability({
      id: 'ui.commandPickerOpen', title: 'Open the command picker', execution: 'window', effect: 'ui',
      description: 'Open the real command picker with a query and optional stable command selection. Waits for rendered acknowledgement; never presses Enter. Hidden/inapplicable selections are reported as not found.',
      input: z.object({ query: z.string().max(2000).default('').describe('Literal text to place in the actual picker search field.'), commandId: z.string().optional().describe('Optional command ID from commands.list to select if visible and applicable. This does not run the command.') }).strict(),
      output: z.object({ query: z.string(), selectedCommandId: z.string().nullable(), requestedSelectionFound: z.boolean(), visibleRows: z.number() }),
      handler: async input => {
        const store = useAppStore.getState()
        if (hasAppInteractionOwner() && !store.commandPaletteOpen) throw new ControlError('unavailable', 'Another surface owns input; inspect or close it first')
        if (input.commandId && !builtInCommandCatalog.some(command => command.id === input.commandId)) throw new ControlError('unavailable', 'Unknown command ID')
        const acknowledgement = paletteRequests.open(input)
        store.openCommandPalette()
        return acknowledgement
      },
    }),
    defineCapability({
      id: 'commands.list', title: 'Search all commands',
      description: 'Enumerate or search every app command by title, keywords and description, including hidden commands. Returns current bindings and complete pagination; listing never executes commands.',
      execution: 'window', effect: 'read', input: z.object({ query: z.string().default('').describe('Search app command titles, keywords and descriptions. Empty string lists all commands, including hidden and unbound entries.'), ...pageInput }).strict(),
      output: pageSchema(commandSchema),
      handler: input => paginate(rankEntries(commandReference(), input.query, commandSearchFields), input, `commands:${input.query}`),
    }),
    defineCapability({
      id: 'commands.describe', title: 'Describe a command',
      description: 'Get the complete description, UI route, risk, surface and effective bindings for one stable command ID.',
      execution: 'window', effect: 'read', input: z.object({ commandId: z.string().describe('Exact command ID from commands.list, not its title or an MCP tool name.') }).strict(), output: commandSchema,
      handler: ({ commandId }) => {
        const command = commandReference().find(entry => entry.id === commandId)
        if (!command) throw new ControlError('unavailable', `Unknown command: ${commandId}`)
        return command
      },
    }),
  ]
}
