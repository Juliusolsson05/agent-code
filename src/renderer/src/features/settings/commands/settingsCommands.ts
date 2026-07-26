import type { CommandDef } from '@renderer/features/command-palette/types'
import { panel, toggle, value } from '@renderer/features/command-palette/commandState'

export const settingsCommands: CommandDef[] = [
  {
    id: 'open-settings',
    category: 'preferences',
    surface: 'app',
    title: 'Open Settings',
    description: '**What it does:** Opens **Settings**.\n\n**Use when:** You want to change app preferences.\n\n**Notes:** Includes appearance, workspace, dictation, experimental, and safety settings.',
    run: ({ ui }) => ui.openSettings(),
  },
  {
    // Persistent Aggressive Debug Logs — developer-mode switch for
    // interval snapshots. This intentionally reuses the Save Debug
    // Logs bundle path instead of streaming extra render logs all
    // day: the user wants crash/close breadcrumbs and complete
    // bundles, not per-frame debug overhead.
    id: 'toggle-aggressive-debug-persistence',
    category: 'developer',
    pickerVisibility: 'debug',
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
    getState: ({ flags }) => toggle(flags.aggressiveDebugPersistenceEnabled),
    run: ({ flags, ui }) =>
      ui.setAggressiveDebugPersistence(!flags.aggressiveDebugPersistenceEnabled),
  },
  {
    id: 'toggle-worktrees-bar',
    category: 'workspace-tools',
    surface: 'app',
    title: 'Worktrees',
    description: '**What it does:** Shows or hides the **Worktrees** panel.\n\n**Use when:** You want branch and worktree activity for the focused project.\n\n**Notes:** Useful for multi-agent git cleanup.',
    keywords: ['worktree', 'worktrees', 'branch', 'git', 'activity', 'agents', 'cleanup'],
    getState: ({ flags }) => panel(flags.worktreesBarOpen),
    run: ({ ui }) => ui.toggleWorktreesBar(),
  },
  // RETIRED: `toggle-worktree-badges`. Same reasoning as Status Mode — a
  // durable visual preference with no momentary scope belongs in Settings
  // only (Interface → Worktree Badges, backed by `showWorktreeBadges`).
  //
  // RETIRED: `dangerous-agents`, which used to arrive here via
  // `...dangerousCommands`. That one is not merely a duplicated preference: it
  // is a SAFETY POSTURE whose enablement reloads every live agent. A palette
  // row that flips it with one keystroke and no preview is the wrong affordance
  // for that, and its old copy even claimed existing agents were unaffected
  // while the runner reloaded them. Settings owns it, where a confirmation can
  // show the exact set of agents about to be replaced.
]
