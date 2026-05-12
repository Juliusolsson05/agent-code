import {
  ACCENTS,
  THEME_MODES,
  WORKSPACE_MODES,
  type AccentId,
  type Settings,
  type ThemeMode,
  type WorkspaceModeId,
} from '@renderer/app-state/settings/types'
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
        type: 'hotkey'
        getValue: (settings: Settings) => string
        onChange: (ctx: SettingActionContext, value: string) => void | Promise<void>
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

const WORKSPACE_MODE_OPTIONS: ChoiceOption<WorkspaceModeId>[] = WORKSPACE_MODES.map(mode => ({
  value: mode.id,
  label: mode.label,
  description:
    mode.id === 'dispatch'
      ? 'Open with the dispatch sidebar + main pane.'
      : 'Open with the classic tiled grid.',
}))

const DICTATION_PROVIDER_OPTIONS: ChoiceOption<Settings['dictationProvider']>[] = [
  {
    value: 'deepgram',
    label: 'Deepgram',
    description: 'Streaming Flux path. Requires DEEPGRAM_API_KEY in the main process environment.',
  },
]

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
      // WHY this entry's copy is so explicit about "first launch":
      // existing users will flip it expecting an immediate effect, and
      // the setting deliberately doesn't behave that way. The friction
      // of a confused user reporting "the setting doesn't work" is
      // worse than verbose UI text. If this ever proves too narrow we
      // can add a "Reset workspace to default mode" action later.
      id: 'default-workspace-mode',
      category: 'workspace',
      title: 'Default Workspace Mode',
      description:
        'Mode the app opens in on first launch. Existing workspaces keep their last-used mode — flipping this later only affects a fresh install.',
      keywords: ['default', 'mode', 'dispatch', 'grid', 'startup', 'launch', 'workspace'],
      control: {
        type: 'select',
        getValue: settings => settings.defaultWorkspaceMode,
        options: WORKSPACE_MODE_OPTIONS,
        columns: 2,
        onSelect: (ctx, value) =>
          ctx.onChange({ defaultWorkspaceMode: value as WorkspaceModeId }),
      },
    },
    {
      id: 'status-mode',
      category: 'workspace',
      title: 'Status Mode',
      description: 'Color agent pane headers while sessions are active so working panes stand out.',
      keywords: ['status', 'header', 'color', 'agent', 'pane', 'active'],
      control: {
        type: 'toggle',
        getValue: settings => settings.showStatusMode,
        onToggle: (ctx, value) => ctx.onChange({ showStatusMode: value }),
      },
    },
    {
      id: 'worktree-badges',
      category: 'workspace',
      title: 'Worktree Badges',
      description: 'Show the inferred git worktree or branch for each agent pane above the composer.',
      keywords: ['worktree', 'branch', 'badge', 'git', 'agent'],
      control: {
        type: 'toggle',
        getValue: settings => settings.showWorktreeBadges,
        onToggle: (ctx, value) => ctx.onChange({ showWorktreeBadges: value }),
      },
    },
    {
      // Replaces the old "Dispatch Terminal" command-palette toggle. The
      // command sat on a per-session `dispatchMode.terminalVisible` flag
      // that re-defaulted to ON every time dispatch was re-entered, which
      // produced the "I turned it off but it's back" failure mode. The
      // settings entry is the single source of truth: off → never mount,
      // on → mount and live as a normal tile-tree leaf.
      id: 'dispatch-project-terminal',
      category: 'workspace',
      title: 'Attach Project Terminal to Dispatch',
      description:
        'When on, Dispatch Mode mounts a project terminal beside the agent list. Off by default.',
      keywords: ['dispatch', 'terminal', 'project', 'attach', 'shell', 'pane'],
      control: {
        type: 'toggle',
        getValue: settings => settings.dispatchProjectTerminal,
        onToggle: (ctx, value) => ctx.onChange({ dispatchProjectTerminal: value }),
      },
    },
    {
      id: 'aggressive-debug-persistence',
      category: 'experimental',
      title: 'Persistent Aggressive Debug Logs',
      description:
        'Periodically save full debug bundles for active agent panes, plus a best-effort final bundle on close. Expensive, intended for Agent Code development.',
      keywords: ['debug', 'logs', 'persistent', 'aggressive', 'autosave', 'render', 'trace'],
      control: {
        type: 'toggle',
        getValue: settings => settings.aggressiveDebugPersistence,
        onToggle: (ctx, value) => ctx.onChange({ aggressiveDebugPersistence: value }),
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
      id: 'dictation-enabled',
      category: 'dictation',
      title: 'Inline Dictation',
      description:
        'Show a voice control inside each composer and insert transcripts as editable draft text.',
      keywords: ['voice', 'dictation', 'speech', 'stt', 'composer', 'microphone'],
      control: {
        type: 'toggle',
        getValue: settings => settings.dictationEnabled,
        onToggle: (ctx, value) => ctx.onChange({ dictationEnabled: value }),
      },
    },
    {
      id: 'dictation-provider',
      category: 'dictation',
      title: 'Speech Provider',
      description:
        'Provider used by the inline composer dictation control. v1 uses the package-owned Deepgram streaming client.',
      keywords: ['voice', 'dictation', 'provider', 'deepgram', 'flux', 'streaming'],
      control: {
        type: 'select',
        getValue: settings => settings.dictationProvider,
        options: DICTATION_PROVIDER_OPTIONS,
        onSelect: (ctx, value) =>
          ctx.onChange({ dictationProvider: value as Settings['dictationProvider'] }),
      },
    },
    {
      id: 'dictation-shortcut',
      category: 'dictation',
      title: 'Dictation Shortcut',
      description:
        'Keyboard binding for toggling the active composer dictation session. Default is fn.',
      keywords: ['voice', 'dictation', 'shortcut', 'binding', 'hotkey', 'keyboard'],
      control: {
        type: 'hotkey',
        getValue: settings => settings.dictationShortcut,
        onChange: (ctx, value) => ctx.onChange({ dictationShortcut: value }),
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
