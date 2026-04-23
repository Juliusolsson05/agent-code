import {
  ACCENTS,
  THEME_MODES,
  type AccentId,
  type Settings,
  type ThemeMode,
} from '@renderer/state/settings/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { SETTING_CATEGORIES, type SettingCategoryId } from '@renderer/features/settings/lib/settingsCategories'

export type SettingActionContext = {
  workspace: Workspace
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onReset: () => void
  onClose: () => void
}

type ChoiceOption<T extends string> = {
  value: T
  label: string
  description?: string
}

export type SettingDefinition =
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      control: {
        type: 'toggle'
        getValue: (settings: Settings) => boolean
        onToggle: (ctx: SettingActionContext, value: boolean) => void | Promise<void>
      }
    }
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      control: {
        type: 'select'
        getValue: (settings: Settings) => string
        options: ChoiceOption<string>[]
        columns?: number
        onSelect: (ctx: SettingActionContext, value: string) => void | Promise<void>
      }
    }
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      control: {
        type: 'action'
        label: string
        tone?: 'neutral' | 'danger'
        onTrigger: (ctx: SettingActionContext) => void | Promise<void>
      }
    }

const THEME_MODE_OPTIONS: ChoiceOption<ThemeMode>[] = THEME_MODES.map(mode => ({
  value: mode.id,
  label: mode.label,
  description: mode.family === 'light' ? 'Light family' : 'Dark family',
}))

const ACCENT_OPTIONS: ChoiceOption<AccentId>[] = ACCENTS.map(accent => ({
  value: accent.id,
  label: accent.name,
}))

export function getSettingsRegistry(): SettingDefinition[] {
  return [
    {
      id: 'theme-mode',
      category: 'appearance',
      title: 'Theme Mode',
      description: 'Switch between the dark and light theme variants.',
      keywords: ['theme', 'mode', 'dark', 'light', 'tokyonight', 'dim'],
      control: {
        type: 'select',
        getValue: settings => settings.mode,
        options: THEME_MODE_OPTIONS,
        columns: 2,
        onSelect: (ctx, value) => ctx.onChange({ mode: value as ThemeMode }),
      },
    },
    {
      id: 'theme-accent',
      category: 'appearance',
      title: 'Accent Color',
      description: 'Choose the shared accent used across chrome, links, and focus states.',
      keywords: ['accent', 'color', 'theme', 'palette'],
      control: {
        type: 'select',
        getValue: settings => settings.accent,
        options: ACCENT_OPTIONS,
        columns: 4,
        onSelect: (ctx, value) => ctx.onChange({ accent: value as AccentId }),
      },
    },
    {
      id: 'high-contrast',
      category: 'appearance',
      title: 'High Contrast',
      description: 'Increase contrast across the selected light or dark theme family.',
      keywords: ['contrast', 'accessibility', 'appearance'],
      control: {
        type: 'toggle',
        getValue: settings => settings.contrast,
        onToggle: (ctx, value) => ctx.onChange({ contrast: value }),
      },
    },
    {
      id: 'custom-rendering',
      category: 'workspace',
      title: 'Custom Rendering',
      description: 'Enable richer widgets for recognized tool output instead of generic rows.',
      keywords: ['custom', 'rendering', 'widgets', 'tool output'],
      control: {
        type: 'toggle',
        getValue: settings => settings.customRendering,
        onToggle: (ctx, value) => ctx.onChange({ customRendering: value }),
      },
    },
    {
      id: 'proxy-streaming',
      category: 'experimental',
      title: 'Proxy-Streamed Semantic Rendering',
      description:
        'Spawn Claude sessions through a local mitmproxy and feed semantic stream events into the app. Requires local proxy setup.',
      keywords: ['proxy', 'streaming', 'semantic', 'mitmproxy', 'claude'],
      control: {
        type: 'toggle',
        getValue: settings => settings.useProxyStreaming,
        onToggle: (ctx, value) => ctx.onChange({ useProxyStreaming: value }),
      },
    },
    {
      id: 'dangerous-agents',
      category: 'safety',
      title: 'Dangerous Agents By Default',
      description:
        'Start Claude and Codex sessions with the bypass flags enabled. Existing live agent sessions are reloaded when this changes.',
      keywords: ['dangerous', 'bypass', 'agents', 'reload', 'safety'],
      control: {
        type: 'toggle',
        getValue: settings => settings.dangerousAgentsEnabled,
        onToggle: async (ctx, value) => {
          if (ctx.settings.dangerousAgentsEnabled === value) return
          ctx.onChange({ dangerousAgentsEnabled: value })
          await ctx.workspace.reloadAgentSessions(value)
        },
      },
    },
    {
      id: 'reset-settings',
      category: 'workspace',
      title: 'Reset Settings',
      description: 'Restore the persisted settings back to their defaults.',
      keywords: ['reset', 'defaults', 'settings'],
      control: {
        type: 'action',
        label: 'Reset To Defaults',
        onTrigger: ctx => ctx.onReset(),
      },
    },
  ]
}

export function matchesSettingQuery(definition: SettingDefinition, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true

  const category = SETTING_CATEGORIES.find(item => item.id === definition.category)
  const haystack = [
    definition.title,
    definition.description,
    ...(category ? [category.label, category.description] : []),
    ...definition.keywords,
  ]
    .join(' ')
    .toLowerCase()

  return haystack.includes(normalized)
}
