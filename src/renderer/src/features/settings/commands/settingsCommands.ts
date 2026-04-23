import type { CommandDef } from '@renderer/features/command-palette/types'
import { dangerousCommands } from '@renderer/features/settings/commands/dangerousCommands'

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
