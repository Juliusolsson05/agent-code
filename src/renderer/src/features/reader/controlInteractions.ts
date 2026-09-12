import type { InteractionReference } from '@control-sdk'
export const readerInteractions: InteractionReference[] = [
  { id: 'reader.history', bindings: ['Alt+Up', 'Alt+Down'], context: 'Reader is the frontmost interaction owner', description: 'Select older/newer conversation messages. A dialog above Reader takes priority.' },
]
