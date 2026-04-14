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
    title: ({ flags }) =>
      `Toggle Custom Rendering  (${flags.customRenderingEnabled ? 'on' : 'off'})`,
    run: ({ ui }) => ui.toggleCustomRendering(),
  },
  ...dangerousCommands,
]
