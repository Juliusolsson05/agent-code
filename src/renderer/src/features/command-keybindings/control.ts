import { z } from 'zod'
import { defineCapability, pageInput, pageSchema, paginate } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { buildDefaultKeybindings } from './defaults'
import { resolveEffectiveKeybindings } from './resolve'
import { RESERVED_INTERACTIONS } from './reservations'
import { rankEntries, primary, body } from '@renderer/features/command-palette/lib/rankEntries'
import { composerInteractions } from '@renderer/workspace/tile-tree/TileLeaf/controlInteractions'
import { paletteInteractions } from '@renderer/features/command-palette/controlInteractions'
import { workspaceInteractions } from '@renderer/features/workspace/controlInteractions'
import { readerInteractions } from '@renderer/features/reader/controlInteractions'
import { pinInteractions } from '@renderer/features/dispatch-pin/controlInteractions'
import { pathInteractions } from '@renderer/features/path-picker/controlInteractions'
import { editorInteractions } from '@renderer/features/editor/controlInteractions'

const bindingSchema = z.object({
  id: z.string(), description: z.string(), inputType: z.enum(['keyboard', 'mouse']),
  source: z.enum(['command', 'fixed', 'configured', 'external']), context: z.string(),
  bindings: z.array(z.string()), defaults: z.array(z.string()), customized: z.boolean(),
  configuredEnabled: z.boolean().optional(),
})

export function keybindingReference(): Array<z.infer<typeof bindingSchema>> {
  const { settings } = useAppStore.getState()
  const defaults = buildDefaultKeybindings()
  // Match the actual router's resolver and context policy. Unknown saved IDs
  // remain visible as overrides, but are not invented as executable commands.
  const effective = new Map(resolveEffectiveKeybindings(settings.commandKeybindingOverrides, defaults).map(entry => [entry.commandId, entry]))
  const catalog = new Map(builtInCommandCatalog.map(command => [command.id, command]))
  const ids = new Set([...catalog.keys(), ...effective.keys()])
  const commands = [...ids].map(id => ({
    id, description: catalog.get(id)?.description ?? 'Saved binding for a command not installed in this build.',
    inputType: 'keyboard' as const, source: 'command' as const,
    context: effective.get(id)?.context ?? 'global', bindings: [...(effective.get(id)?.bindings ?? [])],
    defaults: [...(defaults.find(entry => entry.commandId === id)?.bindings ?? [])], customized: effective.get(id)?.customized ?? false,
  }))
  const fixed = [
    ...RESERVED_INTERACTIONS.map((entry, index) => ({ id: `reserved:${index}`, description: entry.owner, context: entry.context, bindings: entry.bindings })),
    ...composerInteractions, ...paletteInteractions, ...workspaceInteractions, ...readerInteractions,
    ...pinInteractions, ...pathInteractions, ...editorInteractions,
  ].map(entry => ({ ...entry, bindings: [...entry.bindings], defaults: [...entry.bindings], inputType: 'keyboard' as const, source: entry.bindings.length ? 'fixed' as const : 'external' as const, customized: false }))
  const configured = [
    { id: 'dictation.keyboard', description: 'Configured dictation hotkey; requires dictation setup and permission.', context: 'global dictation', inputType: 'keyboard' as const, value: settings.dictationShortcut, defaultValue: DEFAULT_SETTINGS.dictationShortcut, configuredEnabled: settings.dictationEnabled },
    { id: 'dictation.mouse', description: 'Configured app-local mouse dictation trigger.', context: 'Agent Code focused', inputType: 'mouse' as const, value: settings.dictationMouseButton, defaultValue: DEFAULT_SETTINGS.dictationMouseButton, configuredEnabled: settings.dictationEnabled },
    { id: 'palette.mouse', description: 'Configured mouse chord for command-picker access.', context: 'Agent Code focused', inputType: 'mouse' as const, value: settings.paletteMouseChord, defaultValue: DEFAULT_SETTINGS.paletteMouseChord, configuredEnabled: Boolean(settings.paletteMouseChord) },
  ].map(({ value, defaultValue, ...entry }) => ({ ...entry, source: 'configured' as const, bindings: value ? [value] : [], defaults: defaultValue ? [defaultValue] : [], customized: value !== defaultValue }))
  return [...commands, ...fixed, ...configured]
}

export function keybindingControlCapabilities() {
  return [defineCapability({
    id: 'keybindings.list', title: 'List keyboard and mouse interactions',
    description: 'Read every command binding including unbound/custom/unknown saved entries, plus fixed contextual/native interactions and configured dictation/mouse chords. Pagination retains all entries. External editor/provider keymaps are distinguished from app-owned bindings.',
    execution: 'window', effect: 'read', input: z.object({ query: z.string().default(''), ...pageInput }).strict(),
    output: pageSchema(bindingSchema),
    handler: input => paginate(rankEntries(keybindingReference(), input.query, entry => [primary(entry.id), ...entry.bindings.map(primary), body(entry.description), body(entry.context)]), input, `keybindings:${input.query}`),
  })]
}
