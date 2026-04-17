import type { CommandDef } from '../../../commands/types'
import { dangerousCommands } from './dangerousCommands'

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
  ...dangerousCommands,
]
