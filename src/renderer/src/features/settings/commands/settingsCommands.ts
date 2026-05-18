import type { CommandDef } from '@renderer/features/command-palette/types'
import { dangerousCommands } from '@renderer/features/settings/commands/dangerousCommands'

export const settingsCommands: CommandDef[] = [
  {
    id: 'open-settings',
    surface: 'app',
    title: 'Open Settings',
    description: '**What it does:** Opens **Settings**.\n\n**Use when:** You want to change app preferences.\n\n**Notes:** Includes appearance, workspace, dictation, experimental, and safety settings.',
    run: ({ ui }) => ui.openSettings(),
  },
  {
    id: 'toggle-custom-rendering',
    // `debug`: this exists to compare the custom feed renderer against
    // the fallback path — a diagnostic, not an everyday preference.
    surface: 'debug',
    title: 'Custom Rendering',
    description: '**What it does:** Toggles the custom **feed renderer**.\n\n**Use when:** You want to compare custom rendering with the fallback path.\n\n**Notes:** Rendering preference only.',
    getState: ({ flags }) => ({
      label: flags.customRenderingEnabled ? 'On' : 'Off',
      tone: flags.customRenderingEnabled ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleCustomRendering(),
  },
  {
    // Persistent Aggressive Debug Logs — developer-mode switch for
    // interval snapshots. This intentionally reuses the Save Debug
    // Logs bundle path instead of streaming extra render logs all
    // day: the user wants crash/close breadcrumbs and complete
    // bundles, not per-frame debug overhead.
    id: 'toggle-aggressive-debug-persistence',
    surface: 'debug',
    title: 'Persistent Aggressive Debug Logs',
    description: '**What it does:** Periodically saves **debug bundles** for active agents.\n\n**Use when:** You are chasing crashes or disappearing state.\n\n**Notes:** Can create many or large debug files.',
    keywords: [
      'debug',
      'logs',
      'persistent',
      'persistence',
      'aggressive',
      'autosave',
      'render',
      'trace',
      'all agents',
    ],
    getState: ({ flags }) => ({
      label: flags.aggressiveDebugPersistenceEnabled ? 'On' : 'Off',
      tone: flags.aggressiveDebugPersistenceEnabled ? 'accent' : 'neutral',
    }),
    run: ({ flags, ui }) =>
      ui.setAggressiveDebugPersistence(!flags.aggressiveDebugPersistenceEnabled),
  },
  {
    id: 'toggle-worktrees-bar',
    surface: 'app',
    title: 'Worktrees',
    description: '**What it does:** Shows or hides the **Worktrees** panel.\n\n**Use when:** You want branch and worktree activity for the focused project.\n\n**Notes:** Useful for multi-agent git cleanup.',
    keywords: ['worktree', 'worktrees', 'branch', 'git', 'activity', 'agents', 'cleanup'],
    getState: ({ flags }) => ({
      label: flags.worktreesBarOpen ? 'Open' : 'Closed',
      tone: flags.worktreesBarOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleWorktreesBar(),
  },
  {
    id: 'toggle-worktree-badges',
    surface: 'app',
    title: 'Worktree Badges',
    description: '**What it does:** Toggles **worktree badges** on agent rows.\n\n**Use when:** You want branch context visible in panes and **Dispatch**.\n\n**Notes:** Visual-only setting.',
    keywords: ['branch', 'git', 'worktree', 'badge', 'agent'],
    getState: ({ flags }) => ({
      label: flags.worktreeBadgesEnabled ? 'On' : 'Off',
      tone: flags.worktreeBadgesEnabled ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleWorktreeBadges(),
  },
  ...dangerousCommands,
]
