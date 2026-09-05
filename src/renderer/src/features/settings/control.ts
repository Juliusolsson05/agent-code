import { z } from 'zod'
import { ControlError, defineCapability, pageInput, pageSchema, paginate } from '@control-sdk'
import { useAppStore } from '@renderer/app-state/store'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import type { Workspace } from '@renderer/workspace/hook'
import { getSettingsRegistry, settingMetadata, type SettingActionContext, type SettingDefinition } from './lib/settingsRegistry'

const record = z.object({ id: z.string(), title: z.string(), description: z.string(), value: z.union([z.string(), z.boolean()]),
  choices: z.array(z.object({ value: z.string(), label: z.string() })), scope: z.string(), apply: z.string(), revision: z.string() })
type OrdinarySetting = Extract<SettingDefinition, { control: { type: 'toggle' | 'select' } }>
function supported(setting: SettingDefinition): setting is OrdinarySetting {
  const meta = settingMetadata(setting)
  return ['toggle', 'select'].includes(setting.control.type) && meta.storage === 'settings'
    && meta.apply !== 'reload-live-sessions' && meta.status !== 'dangerous' && meta.status !== 'developer'
}

// Reuse setting controls, not a second Settings patch schema. The registry
// owns options, apply policy and side effects. Credentials, managed files and
// fleet-reloading safety controls remain their dedicated UI flows.
export function settingsControlCapabilities(getWorkspace: () => Workspace) {
  const definitions = () => getSettingsRegistry().filter(supported)
  const read = (definition: OrdinarySetting) => {
    const value = definition.control.getValue(useAppStore.getState().settings)
    const metadata = settingMetadata(definition)
    const choices = definition.control.type === 'select' ? definition.control.options.map(({ value, label }) => ({ value, label })) : []
    const entry = { id: definition.id, title: definition.title, description: definition.description, value, choices, scope: metadata.scope, apply: metadata.apply }
    return { ...entry, revision: paginate([entry], { limit: 1 }, `setting:${definition.id}`).revision }
  }
  return [
    defineCapability({ id: 'settings.values', title: 'Read supported ordinary settings', execution: 'window', effect: 'read',
      description: 'List current ordinary toggle/select settings with real allowed choices, scope, apply policy and per-setting revision. Uses the UI registry. This supported subset excludes credentials, managed files and dangerous fleet-reloading controls; settings.reference documents every UI setting. Values belong to this window’s current settings state.',
      input: z.object({ query: z.string().default(''), ...pageInput }).strict(), output: pageSchema(record),
      handler: input => paginate(definitions().map(read).filter(row => `${row.id} ${row.title} ${row.description}`.toLowerCase().includes(input.query.toLowerCase())), input, `settings:${input.query}`),
    }),
    defineCapability({ id: 'settings.set', title: 'Set an ordinary preference through its UI handler', execution: 'window', effect: 'mutation',
      description: 'Set one setting returned by settings.values to an explicit boolean or advertised choice, using its revision and existing UI apply handler. Does not toggle blindly. Scope/apply metadata still applies: a default change may affect only future sessions. Other settings require their documented UI or dedicated tools.',
      input: z.object({ settingId: z.string(), revision: z.string(), value: z.union([z.string(), z.boolean()]) }).strict(), output: record,
      handler: async input => {
        if (getWorkspace().restoreStatus === 'pending' || hasAppInteractionOwner()) throw new ControlError('unavailable', 'Finish the current input-owning surface first')
        const definition = definitions().find(row => row.id === input.settingId)
        if (!definition) throw new ControlError('unavailable', 'Setting is not in settings.values; use its UI')
        const before = read(definition)
        if (before.revision !== input.revision) throw new ControlError('stale_cursor', 'Setting changed; read its value again')
        const unsupported = () => { throw new ControlError('unavailable', 'This setting now requires an interactive UI action') }
        const ctx: SettingActionContext = { workspace: getWorkspace(), settings: useAppStore.getState().settings,
          onChange: patch => useAppStore.getState().setSettings(patch), onClose: unsupported, onReset: unsupported, openThemeEditor: unsupported, deleteSavedTheme: unsupported }
        if (definition.control.type === 'toggle') {
          if (typeof input.value !== 'boolean') throw new ControlError('invalid_input', 'This setting takes a boolean')
          await definition.control.onToggle(ctx, input.value)
        } else {
          if (typeof input.value !== 'string' || !definition.control.options.some(option => option.value === input.value)) throw new ControlError('invalid_input', 'Choose an advertised setting option')
          await definition.control.onSelect(ctx, input.value)
        }
        const after = read(definition)
        if (after.value !== input.value) throw new ControlError('failed', 'Requested value was not observed after applying it', 'unknown')
        return after
      },
    }),
  ]
}
