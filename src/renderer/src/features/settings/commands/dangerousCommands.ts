import type { CommandDef } from '../../command-palette/types'
import { toggleDangerousAgents } from './dangerousActions'

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
