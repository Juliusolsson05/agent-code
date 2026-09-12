import { z } from 'zod'
import { ControlError, defineCapability } from '@control-sdk'
import { createAppWindow, getBrowserWindow } from './windowRegistry'
import { focusWindow } from './focusWindow'

export function windowLifecycleControlCapabilities() {
  return [
    defineCapability({
      id: 'app.windowCreate', title: 'Create an Agent Code window', execution: 'main', effect: 'mutation', completion: 'accepted',
      description: 'Create a separate Agent Code workspace using the same New Window operation as the app menu. Starts the normal default project/agent bootstrap; it does not copy the current workspace. Returns the new stable windowId immediately. Wait for a renderer generation in app.windows before targeting its tools.',
      input: z.object({}).strict(), output: z.object({ windowId: z.string() }), handler: () => ({ windowId: createAppWindow() }),
    }),
    defineCapability({
      id: 'app.windowFocus', title: 'Focus an exact Agent Code window', execution: 'main', effect: 'ui',
      description: 'Restore and focus the windowId from app.windows, waiting for Electron focus acknowledgment before a computer-use handoff. Does not change the selected project or agent within the window. Inspect the resulting UI before typing.',
      input: z.object({ windowId: z.string().describe('Stable windowId from app.windows, not its display number or title.') }).strict(),
      output: z.object({ windowId: z.string(), focused: z.literal(true) }),
      handler: async ({ windowId }) => {
        const window = getBrowserWindow(windowId)
        if (!window || window.isDestroyed()) throw new ControlError('unavailable', 'Window no longer exists')
        await focusWindow(window)
        return { windowId, focused: true as const }
      },
    }),
  ]
}
