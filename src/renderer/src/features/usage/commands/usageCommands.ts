import type { CommandDef } from '@renderer/features/command-palette/types'

export const usageCommands: CommandDef[] = [
  {
    id: 'usage.open',
    category: 'workspace-tools',
    title: 'Usage',
    description: 'Open provider usage for Claude and Codex.',
    surface: 'app',
    keywords: ['quota', 'tokens', 'limits', 'claude', 'codex'],
    run: ({ ui }) => {
      ui.openUsageModal()
      ui.closePalette()
    },
  },
  {
    id: 'usage.toggle-header',
    category: 'preferences',
    surface: 'app',
    title: 'Usage in Header',
    description:
      '**What it does:** Shows or hides **provider usage** in the header bar.\n\n**Use when:** You want quota headroom visible while planning agent work.\n\n**Notes:** Click the header indicator to open the full Usage modal.',
    keywords: ['usage', 'quota', 'header', 'limits', 'tokens', 'claude', 'codex'],
    getState: ({ flags }) => ({
      label: flags.usageHeaderEnabled ? 'On' : 'Off',
      tone: flags.usageHeaderEnabled ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleUsageHeader(),
  },
  {
    id: 'usage.cycle-header-level',
    category: 'preferences',
    surface: 'app',
    title: 'Usage Header Detail',
    description:
      '**What it does:** Cycles the header usage indicator through **minimal → providers → all → detailed**.\n\n**Use when:** You want more or less quota detail in the header.\n\n**Notes:** Also enables the header indicator if it is currently hidden.',
    keywords: ['usage', 'quota', 'level', 'detail', 'cycle', 'header'],
    getState: ({ flags }) => ({
      label: flags.usageHeaderLevel,
      tone: flags.usageHeaderEnabled ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.cycleUsageHeaderLevel(),
  },
]
