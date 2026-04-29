import type { CommandDef } from '@renderer/features/command-palette/types'
import { dangerousCommands } from '@renderer/features/settings/commands/dangerousCommands'

export const settingsCommands: CommandDef[] = [
  {
    id: 'open-settings',
    title: 'Open Settings',
    run: ({ ui }) => ui.openSettings(),
  },
  {
    id: 'toggle-custom-rendering',
    title: 'Custom Rendering',
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
    title: 'Persistent Aggressive Debug Logs',
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
    title: 'Worktrees',
    keywords: ['worktree', 'worktrees', 'branch', 'git', 'activity', 'agents', 'cleanup'],
    getState: ({ flags }) => ({
      label: flags.worktreesBarOpen ? 'Open' : 'Closed',
      tone: flags.worktreesBarOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleWorktreesBar(),
  },
  {
    id: 'toggle-worktree-badges',
    title: 'Worktree Badges',
    keywords: ['branch', 'git', 'worktree', 'badge', 'agent'],
    getState: ({ flags }) => ({
      label: flags.worktreeBadgesEnabled ? 'On' : 'Off',
      tone: flags.worktreeBadgesEnabled ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleWorktreeBadges(),
  },
  ...dangerousCommands,
]
