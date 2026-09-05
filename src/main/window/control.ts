import { z } from 'zod'
import { defineCapability } from '@control-sdk'

type WindowReference = { windowId: string; number: number; title: string; focused: boolean; minimized: boolean;
  generation: string | null; bounds: { x: number; y: number; width: number; height: number } }

export function windowControlCapabilities(listWindows: () => WindowReference[]) {
  return [defineCapability({
    id: 'app.windows', title: 'List Agent Code windows',
    description: 'Identify all open Agent Code windows before choosing an operation target. Returns stable windowId, current renderer generation, title, focus and desktop bounds for computer use. number is the current display order and can change after closing a window; use windowId for subsequent calls. A null generation means the renderer is not ready.',
    execution: 'main', effect: 'read', input: z.object({}).strict(),
    output: z.object({ windows: z.array(z.object({ windowId: z.string(), number: z.number().int(), title: z.string(), focused: z.boolean(), minimized: z.boolean(), generation: z.string().nullable(),
      bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).describe('Electron screen coordinates in device-independent pixels; use the window title/ID to match the computer-use surface.') })) }),
    handler: () => ({ windows: listWindows() }),
  })]
}
