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
