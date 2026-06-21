import {
  ACCENTS,
  FONT_FAMILIES,
  THEME_MODES,
  WORKSPACE_MODES,
  type AccentId,
  type FontFamilyId,
  type Settings,
  type ThemeMode,
  type WorkspaceModeId,
} from '@renderer/app-state/settings/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { SETTING_CATEGORIES, type SettingCategoryId } from '@renderer/features/settings/lib/settingsCategories'
import {
  listPickerCommandMeta,
  type PickerCommandMeta,
} from '@renderer/features/command-palette/registry'

export type SettingActionContext = {
  workspace: Workspace
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onReset: () => void
  onClose: () => void
  openCustomAppearanceEditor: () => void
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
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      control: {
        type: 'command-visibility'
        /** Full command catalog to render rows for. Carried as a value
         *  (not re-derived in the view) so the registry stays the single
         *  source of "what commands exist". */
        commands: PickerCommandMeta[]
        /** Whether a given command currently shows in the picker, after
         *  applying the user's override on top of the declared default.
         *  The view only needs the resolved boolean, not the resolution
         *  rules. */
        isVisible: (settings: Settings, command: PickerCommandMeta) => boolean
        /** Flip one command's visibility. Writes a sparse override entry;
         *  setting it back to the declared default prunes the entry so the
         *  map never accumulates no-op rows. */
        onToggleCommand: (
          ctx: SettingActionContext,
          command: PickerCommandMeta,
          visible: boolean,
        ) => void
        /** Drop all overrides, returning every command to its declared
         *  default. */
        onResetVisibility: (ctx: SettingActionContext) => void
      }
    }

const THEME_MODE_OPTIONS: ChoiceOption<ThemeMode>[] = THEME_MODES.map(mode => ({
  value: mode.id,
  label: mode.label,
  description:
    mode.family === 'custom'
      ? 'JSON colors'
      : mode.family === 'light'
        ? 'Light family'
        : 'Dark family',
}))

const ACCENT_OPTIONS: ChoiceOption<AccentId>[] = ACCENTS.map(accent => ({
  value: accent.id,
  label: accent.name,
}))

const FONT_FAMILY_OPTIONS: ChoiceOption<FontFamilyId>[] = FONT_FAMILIES.map(font => ({
  value: font.id,
  label: font.label,
  // Surfaced under each option because font names alone are bad UX here:
  // most monospace family names sound interchangeable, and the previous
  // picker proved that five "good coding fonts" can be too visually close to
  // be useful. The short texture labels make the intended variation explicit.
  description: font.description,
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

// Resolve a command's effective picker visibility from settings alone.
// Mirrors `commandVisible` in the command registry, minus the live
// `showHiddenCommands` escape hatch (the settings UI always edits the
// underlying preference, never the transient reveal-all state): an
// explicit override wins, else the declared default ('default' shows,
// everything else is hidden). Kept here rather than imported so the
// settings layer doesn't depend on the registry's CommandContext-typed
// internals — it only needs the static rule.
function resolveCommandVisible(settings: Settings, command: PickerCommandMeta): boolean {
  // Defensive optional-chain for the same reason as commandVisible in the
  // registry: never let a missing override map (pre-#249 persisted settings)
  // crash the Settings page render. Degrade to declared default.
  const override = settings.commandVisibilityOverrides?.[command.id]
  if (typeof override === 'boolean') return override
  return command.pickerVisibility === 'default'
}

export function getSettingsRegistry(): SettingDefinition[] {
  // Resolved once per registry build. The command catalog is static for
  // the lifetime of the app (it's the flat `commandDefs` array), so
  // there's no reason to recompute it per render.
  const pickerCommands = listPickerCommandMeta()

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
        onSelect: (ctx, value) => {
          if (value === 'custom') {
            ctx.openCustomAppearanceEditor()
            return
          }
          ctx.onChange({ mode: value as ThemeMode })
        },
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
      // Global app font picker. The selected id resolves through
      // FONT_FAMILIES → applyTheme → --theme-app-font (DOM chrome) +
      // getActiveAppFontFamily (xterm/Monaco). Live-applied — no restart.
      id: 'font-family',
      category: 'appearance',
      title: 'App Font',
      description:
        'Monospace face used across the whole app — UI chrome, code blocks, and terminal panes alike.',
      keywords: ['font', 'monospace', 'typeface', 'family', 'code', 'terminal', 'mono', 'typography'],
      control: {
        type: 'select',
        getValue: settings => settings.fontFamily,
        options: FONT_FAMILY_OPTIONS,
        columns: 2,
        onSelect: (ctx, value) => ctx.onChange({ fontFamily: value as FontFamilyId }),
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
      id: 'auto-send-prompt-suggestion',
      category: 'workspace',
      title: 'Auto-send Prompt Suggestions',
      description:
        'When on, clicking a prompt-suggestion chip sends it immediately as the next prompt. When off, clicking only fills the composer so you can edit it first. On by default.',
      keywords: ['prompt', 'suggestion', 'chip', 'autosend', 'send', 'composer', 'next prompt'],
      control: {
        type: 'toggle',
        getValue: settings => settings.autoSendPromptSuggestion,
        onToggle: (ctx, value) => ctx.onChange({ autoSendPromptSuggestion: value }),
      },
    },
    {
      id: 'command-picker-visibility',
      category: 'commands',
      title: 'Command Picker Visibility',
      description:
        'Choose which commands appear in the command picker. Hiding a command only removes it from the picker list — its keyboard shortcut still works.',
      keywords: [
        'command',
        'picker',
        'palette',
        'visibility',
        'hide',
        'show',
        'advanced',
        'debug',
      ],
      control: {
        type: 'command-visibility',
        commands: pickerCommands,
        isVisible: resolveCommandVisible,
        onToggleCommand: (ctx, command, visible) => {
          const next = { ...ctx.settings.commandVisibilityOverrides }
          // Prune the entry when the new state equals the command's
          // declared default, so the override map only ever holds
          // deliberate deviations. Without this, toggling a command off
          // then on again would leave a redundant `true` (or `false`)
          // that survives a default change in a future release.
          const declaredVisible = command.pickerVisibility === 'default'
          if (visible === declaredVisible) {
            delete next[command.id]
          } else {
            next[command.id] = visible
          }
          ctx.onChange({ commandVisibilityOverrides: next })
        },
        onResetVisibility: ctx => {
          ctx.onChange({ commandVisibilityOverrides: {} })
        },
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
