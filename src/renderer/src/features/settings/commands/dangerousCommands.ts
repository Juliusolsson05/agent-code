import type { CommandDef } from '@renderer/features/command-palette/types'
import { toggleDangerousAgents } from '@renderer/features/settings/commands/dangerousActions'

export const dangerousCommands: CommandDef[] = [
  {
    id: 'dangerous-agents',
    title: 'Dangerous Agents',
    getState: ({ flags }) => ({
      label: flags.dangerousAgentsEnabled ? 'On' : 'Off',
      tone: flags.dangerousAgentsEnabled ? 'danger' : 'neutral',
    }),
    run: toggleDangerousAgents,
  },
]
