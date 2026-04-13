import type { CommandDef } from '../../../commands/types'

export const sessionCommands: CommandDef[] = [
  {
    id: 'toggle-git-bar',
    title: 'Toggle Git Bar',
    run: ({ ui }) => ui.toggleGitBar(),
  },
  {
    id: 'toggle-debug-panel',
    title: 'Toggle Debug Panel',
    run: ({ ui }) => ui.toggleDebugPanel(),
  },
]
