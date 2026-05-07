import type { CommandDef } from '@renderer/features/command-palette/types'
import { toggleDangerousAgents } from '@renderer/features/settings/commands/dangerousActions'

export const dangerousCommands: CommandDef[] = [
  {
    id: 'dangerous-agents',
    title: 'Dangerous Agents',
    description: '**What it does:** Toggles **dangerous agent mode** for future agents.\n\n**Use when:** You explicitly want agents to run with fewer safety restrictions.\n\n**Notes:** Affects new agent sessions, not existing ones.',
    getState: ({ flags }) => ({
      label: flags.dangerousAgentsEnabled ? 'On' : 'Off',
      tone: flags.dangerousAgentsEnabled ? 'danger' : 'neutral',
    }),
    run: toggleDangerousAgents,
  },
]
