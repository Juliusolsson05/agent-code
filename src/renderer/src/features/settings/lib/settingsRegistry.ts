import {
  ACCENTS,
  AGENT_VIEW_MODES,
  CORNER_STYLES,
  FONT_FAMILIES,
  WORKSPACE_MODES,
} from '@renderer/app-state/settings/types'
import type {
  AccentId,
  AgentViewMode,
  CornerStyleId,
  FontFamilyId,
  Settings,
  WorkspaceModeId,
} from '@renderer/app-state/settings/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { SETTING_CATEGORIES } from '@renderer/features/settings/lib/settingsCategories'
import type { SettingCategoryId } from '@renderer/features/settings/lib/settingsCategories'
import type { ConfigurableBuiltInMcpDomain } from '@mcp/shared/types'
import type { MouseButtonBinding } from '@renderer/lib/mouseBinding'
import { coerceMouseChordBinding } from '@renderer/lib/mouseBinding'

/**
 * Machine-readable facts about what a setting actually DOES, rendered as small
 * badges beside its row.
 *
 * WHY this exists: the audit found Settings copy that was misleading in ways
 * prose alone kept reproducing — an "Application defaults" umbrella covering
 * rows with four different scopes, MCP rows that look global but only affect
 * NEW sessions, and Dangerous Agents which claims existing agents are
 * unaffected while enabling it reloads the whole fleet. A user cannot tell
 * these apart by reading, because every row looks the same.
 *
 * Making the difference structured rather than prose means the row itself
 * carries the answer, and a new setting has to state its scope instead of
 * inheriting a paragraph written for something else.
 */
export type SettingMetadata = {
  /** Whose behaviour this changes. */
  scope: 'app' | 'project' | 'session-default' | 'fresh-install'
  /** When the change takes effect. */
  apply: 'immediate' | 'new-session' | 'reload-live-sessions' | 'restart-required'
  /** Where the value actually lives. Not always renderer Settings — some rows
   *  front main-owned setup state, the keychain, or files on disk, which is
   *  what makes "Reset Settings" ambiguous today. */
  storage: 'settings' | 'workspace' | 'setup' | 'keychain' | 'external-files'
  /** Maturity or risk, when it is not ordinary. */
  status?: 'experimental' | 'dangerous' | 'developer'
}

/**
 * The common case, applied when a row does not declare otherwise: an app-wide
 * preference stored in renderer Settings that takes effect at once.
 *
 * Defaulting rather than requiring all ~40 rows to repeat it keeps the
 * exceptions visible — a row carrying explicit metadata is one where the
 * obvious reading would have been WRONG, which is exactly the set a reader
 * needs to notice.
 */
export const DEFAULT_SETTING_METADATA: SettingMetadata = {
  scope: 'app',
  apply: 'immediate',
  storage: 'settings',
}

export function settingMetadata(definition: { metadata?: SettingMetadata }): SettingMetadata {
  return definition.metadata ?? DEFAULT_SETTING_METADATA
}

export type SettingActionContext = {
  workspace: Workspace
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onReset: () => void
  onClose: () => void
  /** null means "create a new theme, seeded from what is currently applied";
   *  an id means "edit that saved theme". One entry point rather than two
   *  because the editor modal is the same in both cases — only its seed and
   *  its save target differ. */
  openThemeEditor: (themeId: string | null) => void
  deleteSavedTheme: (themeId: string) => void
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
      metadata?: SettingMetadata
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
      metadata?: SettingMetadata
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
      metadata?: SettingMetadata
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
      metadata?: SettingMetadata
      control: {
        type: 'mouse-button'
        getValue: (settings: Settings) => MouseButtonBinding
        onChange: (ctx: SettingActionContext, value: MouseButtonBinding) => void | Promise<void>
      }
    }
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      metadata?: SettingMetadata
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
      metadata?: SettingMetadata
      // Marker for the CLI auto-update three-way (Automatic / Notify /
      // Off). The row is rendered by its own self-subscribing component
      // in <SettingsList> — the value lives in setup.json (main-owned),
      // not in Settings, so there's no getValue/onChange to hoist here.
      // See features/cli-updates/CliUpdateBehaviorRow.tsx.
      control: {
        type: 'cli-update-behavior'
      }
    }
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      metadata?: SettingMetadata
      // Marker for the theme grid. The generic `select` control renders
      // uniform value cells; this row needs per-cell Edit/Delete affordances
      // on saved themes plus a trailing "+ New theme…" cell that is an action
      // rather than a value. Same escape hatch as cli-update-behavior.
      // See features/settings/ui/ThemePickerRow.tsx.
      control: {
        type: 'theme-picker'
      }
    }
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      metadata?: SettingMetadata
      // Marker for the voice-dictation Deepgram API-key row. Same
      // rationale as cli-update-behavior above — the value lives in
      // safeStorage-backed main state (see src/main/dictation/
      // apiKeyStore.ts), not in Settings, so we render the row via a
      // self-subscribing component that reads its state over IPC.
      // See features/voice-dictation/DictationApiKeyRow.tsx.
      control: {
        type: 'dictation-api-key'
      }
    }
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      metadata?: SettingMetadata
      // Marker for the dictation history + stats panel. Same rationale as
      // dictation-api-key above: the data lives in a main-owned JSON store
      // (src/main/dictation/historyStore.ts), not in Settings, so there is no
      // getValue/onChange to hoist here. Hoisting it would also mean every
      // Settings render pulled the whole transcript list over IPC.
      // See features/voice-dictation/DictationHistoryRow.tsx.
      control: {
        type: 'dictation-history'
      }
    }
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      metadata?: SettingMetadata
      // Main owns both the canonical document and the external deployment
      // health. A marker row prevents renderer Settings from inventing a second
      // boolean source of truth that could say Active after filesystem failure.
      control: {
        type: 'agent-code-conventions'
      }
    }
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      metadata?: SettingMetadata
      // Custom skills are a collection in main-owned state plus generated
      // provider files. A marker row keeps the list and its deployment health
      // out of the ordinary scalar renderer Settings store.
      control: {
        type: 'agent-code-custom-skills'
      }
    }
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      metadata?: SettingMetadata
      // GitHub packages are main-owned immutable snapshots plus generated
      // provider files. Discovery and deployment health cannot live in the
      // renderer's scalar Settings document.
      control: {
        type: 'agent-code-installed-skills'
      }
    }
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      metadata?: SettingMetadata
      // Marker for the built-in keybinding editor. Self-subscribing for the
      // same reason as cli-update-behavior: the row needs the live effective
      // binding set plus conflict lookup, and hoisting all of that into the
      // registry would make every Settings render recompute it.
      control: {
        type: 'command-keybindings'
      }
    }
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

const AGENT_VIEW_MODE_OPTIONS: ChoiceOption<AgentViewMode>[] = AGENT_VIEW_MODES.map(mode => ({
  value: mode.id,
  label: mode.label,
  description: mode.description,
}))

const CORNER_STYLE_OPTIONS: ChoiceOption<CornerStyleId>[] = CORNER_STYLES.map(style => ({
  value: style.id,
  label: style.label,
  description: style.description,
}))

const DICTATION_PROVIDER_OPTIONS: ChoiceOption<Settings['dictationProvider']>[] = [
  {
    value: 'deepgram',
    label: 'Deepgram',
    description:
      'Streaming Flux path. Paste your Deepgram API key below — get $200 in free credits from console.deepgram.com.',
  },
]

function updateDefaultBuiltInMcpDomain(
  ctx: SettingActionContext,
  domain: ConfigurableBuiltInMcpDomain,
  enabled: boolean,
): void {
  const current = ctx.settings.defaultBuiltInMcpDomains
  // WHY each row rewrites one shared ordered set instead of storing four
  // booleans: the session launch contract already speaks domain arrays, and a
  // single persisted list makes adding a future domain a one-field migration.
  // Filtering before append also makes the helper safe against a same-value UI
  // event without allowing duplicates into the in-memory store.
  const next = enabled
    ? [...current.filter(candidate => candidate !== domain), domain]
    : current.filter(candidate => candidate !== domain)
  ctx.onChange({ defaultBuiltInMcpDomains: next })
}

export function getSettingsRegistry(): SettingDefinition[] {
  return [
    {
      id: 'theme-mode',
      category: 'appearance',
      title: 'Theme',
      description: 'Switch between built-in themes and your saved color schemes.',
      keywords: [
        'theme', 'mode', 'dark', 'light', 'tokyonight', 'dim',
        'custom', 'color', 'colour', 'scheme', 'saved', 'palette',
      ],
      control: { type: 'theme-picker' },
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
      // Title is a stable noun per docs/command-style.md — "Corners", not
      // "Rounded Corners" or "Toggle Corner Radius". The selected tier is the
      // state; the row name is the concept.
      id: 'corner-style',
      category: 'appearance',
      title: 'Corners',
      description:
        'Corner radius for badges, code blocks, and floating panels. Panes, tabs, and terminals stay square at every setting.',
      keywords: [
        'corner', 'corners', 'radius', 'rounded', 'round', 'sharp', 'square',
        'border', 'shape', 'appearance',
      ],
      control: {
        type: 'select',
        getValue: settings => settings.cornerStyle,
        options: CORNER_STYLE_OPTIONS,
        columns: 3,
        onSelect: (ctx, value) => ctx.onChange({ cornerStyle: value as CornerStyleId }),
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
      // Only affects a fresh install — existing workspaces keep their last-used
      // mode, which the description says but the row could not show.
      metadata: { scope: 'fresh-install', apply: 'new-session', storage: 'settings' },
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
      // WHY this setting belongs in Workspace rather than Commands:
      // terminal/agent/hybrid is the pane surface contract that commands must
      // respect, not a single command's preference. Commands only declare
      // whether they require a rendered feed; the central display policy turns
      // that into "available, disabled, or temporarily render in hybrid."
      id: 'agent-view-mode',
      category: 'workspace',
      title: 'Agent View Mode',
      description:
        'Choose whether Claude and Codex panes show Agent Code rendering, the provider terminal, or terminal-first Hybrid mode that renders only while a feature needs the feed.',
      keywords: ['agent', 'view', 'mode', 'terminal', 'raw', 'hybrid', 'renderer', 'feed', 'tui'],
      metadata: { scope: 'app', apply: 'new-session', storage: 'settings' },
      control: {
        type: 'select',
        getValue: settings => settings.agentViewMode,
        options: AGENT_VIEW_MODE_OPTIONS,
        columns: 3,
        onSelect: (ctx, value) => ctx.onChange({ agentViewMode: value as AgentViewMode }),
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
      id: 'usage-header',
      category: 'workspace',
      title: 'Usage in Header',
      description:
        'Show Claude and Codex quota usage in the header bar. Click the indicator to open the full Usage modal.',
      keywords: ['usage', 'quota', 'limits', 'header', 'tokens', 'claude', 'codex'],
      control: {
        type: 'toggle',
        getValue: settings => settings.usageHeaderEnabled,
        onToggle: (ctx, value) => ctx.onChange({ usageHeaderEnabled: value }),
      },
    },
    {
      // The registry has no dependent-visibility concept, so this select
      // stays visible while the toggle above is off — it simply has no
      // visible effect until the header is enabled, and the description
      // says so. Modeling enable+level as one 5-option select was
      // rejected: the palette needs a plain on/off toggle command, and
      // splitting keeps setting↔command mappings 1:1.
      id: 'usage-header-level',
      category: 'workspace',
      title: 'Usage Header Detail',
      description:
        'How much detail the header usage indicator shows (no effect while Usage in Header is off).',
      keywords: ['usage', 'quota', 'level', 'detail', 'header'],
      control: {
        type: 'select',
        getValue: settings => settings.usageHeaderLevel,
        options: [
          { value: 'minimal', label: 'Minimal', description: 'Single worst-case percentage across both providers.' },
          { value: 'providers', label: 'Providers', description: 'One chip per provider showing its most constrained limit.' },
          { value: 'all', label: 'All limits', description: 'Every active limit row per provider, compact labels.' },
          { value: 'detailed', label: 'Detailed', description: 'All limits plus severity bars and reset countdowns.' },
        ],
        onSelect: (ctx, value) =>
          ctx.onChange({ usageHeaderLevel: value as Settings['usageHeaderLevel'] }),
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
      id: 'agent-code-conventions',
      category: 'agents',
      title: 'Agent Code Conventions',
      description: 'Apply personal development rules to every supported agent provider.',
      keywords: [
        'conventions', 'rules', 'instructions', 'agents', 'claude', 'codex',
        'opencode', 'skills', 'commits', 'git', 'testing', 'development practices',
      ],
      // Personal provider skills are machine-wide and are guaranteed for newly
      // spawned agents. A live provider may cache skill discovery, so calling
      // this immediate would promise more than the integration can enforce.
      metadata: { scope: 'app', apply: 'new-session', storage: 'external-files' },
      control: { type: 'agent-code-conventions' },
    },
    {
      id: 'agent-code-custom-skills',
      category: 'agents',
      title: 'Custom Skills',
      description: 'Create and manage portable personal Agent Skills authored in Agent Code.',
      keywords: [
        'custom', 'skills', 'instructions', 'agents', 'claude', 'codex', 'opencode',
        'personal', 'manage', 'editor',
      ],
      metadata: { scope: 'app', apply: 'new-session', storage: 'external-files' },
      control: { type: 'agent-code-custom-skills' },
    },
    {
      id: 'agent-code-installed-skills',
      category: 'agents',
      title: 'Installed Skills',
      description: 'Review and install portable Agent Skills from public GitHub repositories.',
      keywords: [
        'installed', 'skills', 'github', 'repository', 'import', 'source', 'update',
        'claude', 'codex', 'opencode', 'personal', 'packages',
      ],
      metadata: { scope: 'app', apply: 'new-session', storage: 'external-files' },
      control: { type: 'agent-code-installed-skills' },
    },
    {
      id: 'default-orchestration-mcp',
      category: 'agents',
      title: 'Orchestration MCP for New Agents',
      description:
        'Start new Claude and Codex agents with Agent Code orchestration tools. Existing sessions are unchanged and can still toggle this capability independently from the command picker.',
      keywords: ['mcp', 'orchestration', 'default', 'new agents', 'claude', 'codex'],
      control: {
        type: 'toggle',
        getValue: settings => settings.defaultBuiltInMcpDomains.includes('orchestration'),
        onToggle: (ctx, value) => updateDefaultBuiltInMcpDomain(ctx, 'orchestration', value),
      },
    },
    {
      id: 'default-ai-workspace-mcp',
      category: 'agents',
      title: 'AI Workspace MCP for New Agents',
      description:
        'Start new Claude and Codex agents with tools for curating cross-worktree review workspaces. Existing sessions keep their own command-picker selection.',
      keywords: ['mcp', 'ai workspace', 'review', 'default', 'new agents', 'claude', 'codex'],
      control: {
        type: 'toggle',
        getValue: settings => settings.defaultBuiltInMcpDomains.includes('ai_workspace'),
        onToggle: (ctx, value) => updateDefaultBuiltInMcpDomain(ctx, 'ai_workspace', value),
      },
    },
    {
      id: 'default-agent-transcripts-mcp',
      category: 'agents',
      title: 'Agent Transcripts MCP for New Agents',
      description:
        'Start new Claude and Codex agents with bounded transcript file tools. Existing sessions remain unchanged and can override this default independently.',
      keywords: ['mcp', 'transcript', 'transcripts', 'default', 'new agents', 'claude', 'codex'],
      control: {
        type: 'toggle',
        getValue: settings => settings.defaultBuiltInMcpDomains.includes('agent_transcripts'),
        onToggle: (ctx, value) => updateDefaultBuiltInMcpDomain(ctx, 'agent_transcripts', value),
      },
    },
    {
      id: 'default-agent-management-mcp',
      category: 'agents',
      title: 'Agent Management MCP for New Agents',
      description:
        'Start new Claude and Codex agents with project-wide agent inventory, transcript reading, prompting, and explicitly authorized close tools. Existing sessions remain unchanged and can override this default independently.',
      keywords: ['mcp', 'agent management', 'agents', 'project', 'cleanup', 'default', 'new agents', 'claude', 'codex'],
      control: {
        type: 'toggle',
        getValue: settings => settings.defaultBuiltInMcpDomains.includes('agent_management'),
        onToggle: (ctx, value) => updateDefaultBuiltInMcpDomain(ctx, 'agent_management', value),
      },
    },
    {
      id: 'default-workflow-mcp',
      category: 'agents',
      title: 'Workflow MCP for New Codex Agents',
      description:
        'Codex only. Claude uses its native workflow feature, so Agent Code never injects Workflow MCP into Claude sessions. Existing Codex sessions keep their own command-picker selection.',
      keywords: ['mcp', 'workflow', 'workflows', 'codex', 'default', 'new agents', 'claude native'],
      control: {
        type: 'toggle',
        getValue: settings => settings.defaultBuiltInMcpDomains.includes('workflows'),
        onToggle: (ctx, value) => updateDefaultBuiltInMcpDomain(ctx, 'workflows', value),
      },
    },
    {
      id: 'command-keybindings',
      category: 'commands',
      title: 'Commands and Shortcuts',
      description:
        'Assign keyboard shortcuts, and choose which commands appear in the command picker. A command may have several bindings or none; conflicts are blocked and name whatever already owns the chord. Hiding a command only removes it from the picker list — its shortcut still works.',
      // Carries BOTH vocabularies. This row absorbed the deleted
      // 'Command Picker Visibility' row, and Settings search matches on
      // keywords — so dropping that row's terms would mean a user typing
      // "hide" or "visibility" (the words for the thing they want) gets no
      // result at all, even though the control is right there.
      keywords: [
        'keybinding',
        'keyboard',
        'shortcut',
        'chord',
        'bind',
        'rebind',
        'hotkey',
        'conflict',
        'command',
        'picker',
        'palette',
        'visibility',
        'visible',
        'hide',
        'hidden',
        'show',
        'advanced',
        'experimental',
        'debug',
      ],
      metadata: { scope: 'app', apply: 'immediate', storage: 'settings' },
      control: { type: 'command-keybindings' },
    },
    {
      id: 'navigation-commands',
      category: 'commands',
      title: 'Navigation Commands',
      description:
        'Show Next/Previous Tab and Focus Pane Left/Right/Up/Down in the command picker. Their keyboard shortcuts always work, whether this is on or off.',
      keywords: [
        'navigation',
        'nav',
        'focus',
        'pane',
        'tab',
        'next',
        'previous',
        'group',
      ],
      metadata: { scope: 'app', apply: 'immediate', storage: 'settings' },
      control: {
        type: 'toggle',
        // Deliberately phrased as "show in the picker", not "enable
        // navigation". The audit's naming rule is that a control must name what
        // it actually changes: this one adds or removes six rows from a list,
        // and a user who read it as "turn navigation off" would be wrong in a
        // way that costs them their arrow keys.
        getValue: settings => settings.navigationCommandsEnabled,
        onToggle: (ctx, value) => ctx.onChange({ navigationCommandsEnabled: value }),
      },
    },
    {
      id: 'prompt-templates-in-command-search',
      category: 'commands',
      title: 'Prompt Templates in Command Search',
      description:
        'Include matching prompt templates after you type in the command palette. The default menu stays command-only.',
      keywords: ['prompt', 'template', 'command', 'palette', 'picker', 'search', 'launcher'],
      control: {
        type: 'toggle',
        getValue: settings => settings.promptTemplatesInCommandSearchEnabled,
        onToggle: (ctx, value) => ctx.onChange({
          promptTemplatesInCommandSearchEnabled: value,
        }),
      },
    },
    {
      id: 'aggressive-debug-persistence',
      category: 'experimental',
      title: 'Persistent Aggressive Debug Logs',
      description:
        'Periodically save full debug bundles for active agent panes, plus a best-effort final bundle on close. Expensive, intended for Agent Code development.',
      keywords: ['debug', 'logs', 'persistent', 'aggressive', 'autosave', 'render', 'trace'],
      // Writes continuously to disk. 'developer' is the honest maturity label for
      // a setting whose real cost is storage the user never sees.
      metadata: { scope: 'app', apply: 'immediate', storage: 'settings', status: 'developer' },
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
      // Marker row rendered by <DictationApiKeyRow /> — see the registry
      // type union for the WHY on marker rows. The row is self-subscribed
      // to main via IPC because the key lives outside Zustand (safeStorage
      // -backed setup.json sibling).
      id: 'dictation-api-key',
      category: 'dictation',
      title: 'Deepgram API Key',
      description:
        'Encrypted with your system keyring. Get $200 free credits at console.deepgram.com — see the Voice Dictation guide.',
      keywords: [
        'voice',
        'dictation',
        'api',
        'key',
        'deepgram',
        'credentials',
        'secret',
        'token',
      ],
      // Lives in safeStorage-backed main state, NOT renderer Settings — which is
      // why 'Reset Settings' does not clear it.
      metadata: { scope: 'app', apply: 'immediate', storage: 'keychain' },
      control: { type: 'dictation-api-key' },
    },
    {
      id: 'dictation-history',
      category: 'dictation',
      title: 'Dictation History',
      description:
        'Words spoken, average speaking rate, and your recent transcripts. Stored locally on this machine and never uploaded — audio is never kept, only text.',
      keywords: [
        'voice',
        'dictation',
        'history',
        'recents',
        'recent',
        'stats',
        'statistics',
        'words',
        'wpm',
        'speed',
        'transcript',
        'copy',
        'clipboard',
      ],
      // A JSON file under STATE_DIR, not renderer Settings — so 'Reset
      // Settings' does not clear it, and the badge has to say so.
      metadata: { scope: 'app', apply: 'immediate', storage: 'external-files' },
      control: { type: 'dictation-history' },
    },
    {
      id: 'dictation-shortcut',
      category: 'dictation',
      title: 'Dictation Shortcut',
      description:
        'Cmd+Shift+D is a no-permission toggle: press once to record and again to finish. Choosing Fn enables hold-to-talk and requires macOS Accessibility permission.',
      keywords: ['voice', 'dictation', 'shortcut', 'binding', 'hotkey', 'keyboard'],
      control: {
        type: 'hotkey',
        getValue: settings => settings.dictationShortcut,
        onChange: (ctx, value) => ctx.onChange({ dictationShortcut: value }),
      },
    },
    {
      id: 'dictation-mouse-button',
      category: 'dictation',
      title: 'Dictation Mouse Button',
      description:
        'Hold a mouse button to talk and release to transcribe. Requires Inline Dictation above. Works while Agent Code is focused — no system permission needed. Only the middle and side buttons can be bound, the bound button stops doing its normal job app-wide, and a stray click will briefly open the microphone before it is discarded.',
      keywords: [
        'voice',
        'dictation',
        'mouse',
        'button',
        'middle',
        'side',
        'thumb',
        'hold',
        'push to talk',
        'binding',
      ],
      control: {
        type: 'mouse-button',
        getValue: settings => settings.dictationMouseButton,
        onChange: (ctx, value) => ctx.onChange({ dictationMouseButton: value }),
      },
    },
    {
      id: 'palette-mouse-chord',
      category: 'commands',
      title: 'Command Palette Mouse Chord',
      description:
        'Hold the middle button and press right to open the command palette. Without it the palette is keyboard-only, and so is every command that has no shortcut. While the chord is armed the right-click menu is suppressed, and a terminal running a mouse-aware TUI will not see either button.',
      keywords: [
        'mouse',
        'chord',
        'command',
        'palette',
        'middle',
        'right',
        'click',
        'binding',
        'pointer',
      ],
      control: {
        type: 'select',
        getValue: settings => settings.paletteMouseChord,
        options: [
          { value: '', label: 'Off' },
          { value: 'Middle+Right', label: 'Middle + Right' },
        ],
        columns: 2,
        // WHY a select and not a capture control like the dictation row: the
        // chord vocabulary is a closed two-item set, so there is nothing to
        // discover by pressing. The dictation row captures because nobody can
        // tell which physical thumb button reports DOM button 3 versus 4.
        onSelect: (ctx, value) =>
          ctx.onChange({ paletteMouseChord: coerceMouseChordBinding(value) }),
      },
    },
    {
      id: 'mouse-mode',
      category: 'workspace',
      title: 'Mouse Mode',
      description:
        'Show pointer-only controls that a keyboard user does not need — currently Send and Stop buttons under the composer. Costs a row of height in every agent pane, which is why it is opt-in rather than always on.',
      keywords: [
        'mouse',
        'pointer',
        'send',
        'stop',
        'button',
        'composer',
        'click',
        'accessibility',
      ],
      control: {
        type: 'toggle',
        getValue: settings => settings.mouseModeEnabled,
        onToggle: (ctx, value) => ctx.onChange({ mouseModeEnabled: value }),
      },
    },
    {
      id: 'dangerous-agents',
      category: 'safety',
      title: 'Dangerous Agents By Default',
      description:
        'Start Claude and Codex sessions with the bypass flags enabled. Existing live agent sessions are reloaded when this changes.',
      keywords: ['dangerous', 'bypass', 'agents', 'reload', 'safety'],
      // The audit's sharpest copy defect: this row said existing agents were
      // unaffected while enabling it RELOADS the whole fleet.
      metadata: { scope: 'app', apply: 'reload-live-sessions', storage: 'settings', status: 'dangerous' },
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
      // Kept in the experimental category alongside proxy-streaming for
      // now — the auto-updater is opinionated (it takes over the
      // upstream CLIs' own update flow) and users may want to see it in
      // the same drawer as other things that reshape default behavior
      // rather than mixed into workspace polish toggles. If it graduates
      // to being the obvious default it can move.
      id: 'cli-update-behavior',
      category: 'experimental',
      title: 'CLI Auto-Updates',
      description:
        "Detect new Claude Code and Codex releases on launch and update the user's installed CLI in the background using the correct install method.",
      keywords: [
        'cli',
        'update',
        'auto',
        'claude',
        'codex',
        'version',
        'npm',
        'brew',
        'homebrew',
        'winget',
      ],
      // Owned by main's setup.json, not renderer Settings.
      metadata: { scope: 'app', apply: 'immediate', storage: 'setup' },
      control: { type: 'cli-update-behavior' },
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
