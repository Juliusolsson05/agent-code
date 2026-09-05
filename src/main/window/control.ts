import { z } from 'zod'
import { defineCapability } from '@control-sdk'

export function windowControlCapabilities(listWindows: () => Array<{ windowId: string; focused: boolean; generation: string | null }>) {
  return [defineCapability({
    id: 'app.windows', title: 'List application windows',
    description: 'List stable window IDs and current renderer generations. A null generation means the renderer is not ready for control.',
    execution: 'main', effect: 'read', input: z.object({}).strict(),
    output: z.object({ windows: z.array(z.object({ windowId: z.string(), focused: z.boolean(), generation: z.string().nullable() })) }),
    handler: () => ({ windows: listWindows() }),
  })]
}
