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
      id: 'ui.commandPickerOpen', title: 'Open the command picker', execution: 'window', effect: 'ui',
      description: 'Open the real command picker with a query and optional stable command selection. Waits for rendered acknowledgement; never presses Enter. Hidden/inapplicable selections are reported as not found.',
      input: z.object({ query: z.string().max(2000).default(''), commandId: z.string().optional() }).strict(),
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
      execution: 'window', effect: 'read', input: z.object({ query: z.string().default(''), ...pageInput }).strict(),
      output: pageSchema(commandSchema),
      handler: input => paginate(rankEntries(commandReference(), input.query, commandSearchFields), input, `commands:${input.query}`),
    }),
    defineCapability({
      id: 'commands.describe', title: 'Describe a command',
      description: 'Get the complete description, UI route, risk, surface and effective bindings for one stable command ID.',
      execution: 'window', effect: 'read', input: z.object({ commandId: z.string() }).strict(), output: commandSchema,
      handler: ({ commandId }) => {
        const command = commandReference().find(entry => entry.id === commandId)
        if (!command) throw new ControlError('unavailable', `Unknown command: ${commandId}`)
        return command
      },
    }),
  ]
}
