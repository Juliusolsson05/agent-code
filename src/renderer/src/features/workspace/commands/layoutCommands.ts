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
    title: 'Status Mode',
    getState: ({ workspace }) => ({
      label: workspace.statusMode ? 'On' : 'Off',
      tone: workspace.statusMode ? 'accent' : 'neutral',
    }),
    run: ({ workspace }) => workspace.toggleStatusMode(),
  },
]
