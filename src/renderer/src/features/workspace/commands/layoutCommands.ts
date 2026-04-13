import type { CommandDef } from '../../../commands/types'

export const layoutCommands: CommandDef[] = [
  {
    id: 'normalize-layout',
    title: 'Normalize Layout',
    run: ({ workspace }) => workspace.normalizeLayout(),
  },
  {
    id: 'hard-normalize-layout',
    title: 'Hard Normalize Layout',
    run: ({ workspace }) => workspace.hardNormalizeLayout(),
  },
  {
    id: 'rotate-layout',
    title: 'Rotate Layout',
    run: ({ workspace }) => workspace.rotateLayout(),
  },
  {
    id: 'toggle-status-mode',
    title: 'Toggle Status Mode',
    run: ({ workspace }) => workspace.toggleStatusMode(),
  },
]
