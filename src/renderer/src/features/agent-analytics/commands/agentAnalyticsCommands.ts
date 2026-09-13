import { panel } from '@renderer/features/command-palette/commandState'
import type { CommandDef } from '@renderer/features/command-palette/types'

export const agentAnalyticsCommands: CommandDef[] = [
  {
    // Agent Analytics (#964). App-surface like Usage: it spans every tab and
    // window, so it must open with nothing focused. Default picker tier because
    // it is the everyday "what did my time go to" view the user asked for, not
    // niche maintenance.
    id: 'agent-analytics.open',
    category: 'workspace-tools',
    title: 'Open Agent Analytics',
    description: '**What it does:** Shows how much agent working time went to each project tab, repository and agent.\n\n**Use when:** You want to see what your time and agents were spent on over the last day, week, month or all time.\n\n**Notes:** Agent-hours sum parallel agents; wall-clock counts the same hour once. Time the machine was asleep and time an agent waited on your answer are not counted. History starts when recording began.',
    surface: 'app',
    keywords: ['analytics', 'time', 'hours', 'projects', 'agents', 'working', 'report', 'stats', 'spent'],
    getState: ({ flags }) => panel(flags.agentAnalyticsOpen),
    run: ({ ui, flags }) => {
      // Round-trips like Usage: open and close are separate store actions, so
      // the command reads the flag and branches.
      if (flags.agentAnalyticsOpen) {
        ui.closeAgentAnalytics()
        return
      }
      ui.openAgentAnalytics()
      ui.closePalette()
    },
  },
]
