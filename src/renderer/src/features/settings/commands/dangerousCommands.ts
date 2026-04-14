import type { CommandDef } from '../../../commands/types'
import {
  disableDangerousAgents,
  enableDangerousAgents,
  toggleDangerousAgents,
} from './dangerousActions'

export const dangerousCommands: CommandDef[] = [
  {
    id: 'enable-dangerous-agents',
    title: 'Enable Dangerous Agents',
    when: ({ flags }) => !flags.dangerousAgentsEnabled,
    run: enableDangerousAgents,
  },
  {
    id: 'disable-dangerous-agents',
    title: 'Disable Dangerous Agents',
    when: ({ flags }) => flags.dangerousAgentsEnabled,
    run: disableDangerousAgents,
  },
  {
    id: 'toggle-dangerous-agents',
    title: ({ flags }) =>
      `Toggle Dangerous Agents  (${flags.dangerousAgentsEnabled ? 'on' : 'off'})`,
    run: toggleDangerousAgents,
  },
]
