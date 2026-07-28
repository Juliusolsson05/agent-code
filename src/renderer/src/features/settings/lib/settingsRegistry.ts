import {
  ACCENTS,
  AGENT_VIEW_MODES,
  FONT_FAMILIES,
  WORKSPACE_MODES,
} from '@renderer/app-state/settings/types'
import type {
  AccentId,
  AgentViewMode,
  FontFamilyId,
  Settings,
  WorkspaceModeId,
} from '@renderer/app-state/settings/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { SETTING_CATEGORIES } from '@renderer/features/settings/lib/settingsCategories'
import type { SettingCategoryId } from '@renderer/features/settings/lib/settingsCategories'
import { listPickerCommandMeta } from '@renderer/features/command-palette/registry'
import { isVisibleInPicker } from '@renderer/features/command-palette/pickerVisibility'
import type { PickerCommandMeta } from '@renderer/features/command-palette/registry'
import type { CommandDef } from '@renderer/features/command-palette/types'
import type { ExtensionListEntry } from '@shared/types/extensions'
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
      // Marker for the extension installer. Same escape hatch as
      // cli-update-behavior: the truth lives in main (extensions.json plus the
      // bundle directories on disk), not in Settings, so the row owns its own
      // IPC round-trip. It is also the only row that is a whole interactive
      // surface — a text input, an install action, and a list with per-row
      // update/remove — which no generic control type can express.
      // See apps/ui/AppsSettingsRow.tsx.
      control: {
        type: 'apps'
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
      // Marker for the built-in keybinding editor. Self-subscribing for the
      // same reason as cli-update-behavior: the row needs the live effective
      // binding set plus conflict lookup, and hoisting all of that into the
      // registry would make every Settings render recompute it.
      control: {
        type: 'command-keybindings'
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
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      metadata?: SettingMetadata
      // Marker for one extension-contributed setting. Self-subscribing like the
      // other markers, because the VALUE lives in the extension's main-owned
      // storage (EXTENSION_STATE_DIR), never the zustand-persist blob (#249). The
      // payload is everything the row needs to read/write that store; the row owns
      // its own IPC round-trip. See apps/ui/ExtensionSettingRow.tsx.
      control: {
        type: 'extension'
        /** Storage namespace (appId) — the owning extension's id. */
        extensionId: string
        /** Storage key — the setting's `<extensionId>.<name>` contribution id. */
        settingId: string
        valueType: 'boolean' | 'number' | 'string'
        default: boolean | number | string
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

const DICTATION_PROVIDER_OPTIONS: ChoiceOption<Settings['dictationProvider']>[] = [
  {
    value: 'deepgram',
    label: 'Deepgram',
    description:
      'Streaming Flux path. Paste your Deepgram API key below — get $200 in free credits from console.deepgram.com.',
  },
]

// Resolve a command's effective picker visibility from settings alone.
// Mirrors `commandVisible` in the command registry, minus the live
// `showHiddenCommands` escape hatch (the settings UI always edits the
// underlying preference, never the transient reveal-all state).
//
// This now delegates to the SHARED resolver rather than re-implementing the
// rule. It used to be a private second copy, justified by "the settings layer
// shouldn't depend on the registry's CommandContext-typed internals" — a real
// concern that `pickerVisibility.ts` removed by taking a context-free policy
// struct instead of a CommandContext.
//
// Keeping the copy after that was an active defect, not just duplication: the
// copy knew about overrides and the declared tier only, so it never learned
// about the Navigation Commands group. On a fresh install Settings rendered
// all six navigation switches ON (they declare no tier, so the copy said
// "visible") while the palette omitted them — Settings stating the opposite of
// what the user could see. Toggling one wrote an override and still changed
// nothing, because the group gate deliberately outranks per-command overrides.
// That is exactly the "switches that appear able to override their parent"
// shape the precedence rule exists to prevent.
//
// `showHiddenCommands: false` is passed deliberately: Settings shows the
// PERSISTED preference, not the transient reveal-all state, so a user reading
// this list sees what their profile actually does.
function resolveCommandVisible(settings: Settings, command: PickerCommandMeta): boolean {
  return isVisibleInPicker(
    {
      id: command.id,
      pickerVisibility: command.pickerVisibility,
      commandGroup: command.commandGroup,
    },
    {
      overrides: settings.commandVisibilityOverrides,
      showHiddenCommands: false,
      navigationCommandsEnabled: settings.navigationCommandsEnabled,
    },
  )
}

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

/**
 * `SettingDefinition`s for every contributed extension setting. Reads manifests
 * only (no bundle import), the settings sibling of deriveExtensionCommands. Rows
 * are the self-subscribing 'extension' marker; the value lives in per-extension
 * storage, never the Settings blob. First-wins on a cross-extension id collision,
 * matching the command/keybinding derivations.
 */
function deriveExtensionSettings(
  installed: readonly ExtensionListEntry[],
): SettingDefinition[] {
  const seen = new Set<string>()
  const rows: SettingDefinition[] = []

  for (const entry of installed) {
    if (!entry.present) continue
    for (const setting of entry.manifest.contributes?.settings ?? []) {
      if (seen.has(setting.id)) continue
      seen.add(setting.id)
      rows.push({
        id: setting.id,
        category: 'apps',
        // Prefix with the extension name so a flat Extensions category still reads
        // as grouped by owner, and two extensions' identically-titled settings stay
        // distinguishable.
        title: `${entry.manifest.name}: ${setting.title}`,
        description: setting.description ?? '',
        keywords: [entry.manifest.name, setting.title, entry.manifest.id],
        control: {
          type: 'extension',
          extensionId: entry.manifest.id,
          settingId: setting.id,
          valueType: setting.type,
          default: setting.default,
        },
      })
    }
  }

  return rows
}

export function getSettingsRegistry(
  // Extension-contributed commands, derived from installed manifests by the
  // caller. Threaded in so the "Commands" category lists them alongside
  // first-party commands — which is also what makes them assignable a keybinding
  // in the editor, since it iterates this same catalog. Empty default keeps every
  // non-extension caller unchanged. The first-party catalog is static, but the
  // extension set changes on install/remove, so this is no longer a per-lifetime
  // constant and must be recomputed when the caller's extension list changes.
  extensionCommands: readonly CommandDef[] = [],
  // Installed extensions, so contributed settings render as rows. Same empty
  // default + install/remove-recompute reasoning as extensionCommands above.
  installedExtensions: readonly ExtensionListEntry[] = [],
): SettingDefinition[] {
  const pickerCommands = listPickerCommandMeta(extensionCommands)

  return [
    // Extension-contributed settings, one row each, under the Extensions category.
    // Derived from manifests (no bundle import); an uninstall drops the manifest
    // from installedExtensions and the rows vanish with it, leaving a clean block.
    ...deriveExtensionSettings(installedExtensions),
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
      // Deploys a file into the project on disk.
      metadata: { scope: 'project', apply: 'immediate', storage: 'external-files' },
      control: { type: 'agent-code-conventions' },
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
      title: 'Keyboard Shortcuts',
      description:
        'Assign, add, or remove keyboard shortcuts for built-in commands. A command may have several bindings or none. Conflicts are blocked and name the command or app interaction that already owns the chord.',
      keywords: [
        'keybinding',
        'keyboard',
        'shortcut',
        'chord',
        'bind',
        'rebind',
        'hotkey',
        'conflict',
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
      metadata: { scope: 'app', apply: 'immediate', storage: 'settings' },
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
      // Built-in apps listing. A marker row with no value — the content is
      // apps/registry.ts, which is compile-time data. Deliberately NOT mirrored
      // into Settings: extension-adjacent state must stay out of the
      // zustand-persist blob (a forgotten version bump there black-screened
      // launch twice, #249), and here there is nothing to persist anyway.
      // See apps/ui/AppsSettingsRow.tsx.
      id: 'apps-installed',
      category: 'apps',
      title: 'Extensions',
      description: 'Install, update, and remove extensions from GitHub repositories.',
      keywords: ['apps', 'extensions', 'plugins', 'install', 'github', 'tools'],
      control: { type: 'apps' },
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
