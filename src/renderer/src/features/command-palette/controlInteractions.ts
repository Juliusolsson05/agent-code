import type { InteractionReference } from '@control-sdk'
export const paletteInteractions: InteractionReference[] = [
  { id: 'palette.navigate', bindings: ['Up', 'Down'], context: 'open command picker', description: 'Move the selected row in the active picker mode.' },
  { id: 'palette.confirm', bindings: ['Enter'], context: 'open command picker', description: 'Invoke the selected command/item or complete the picker mode’s selected action.' },
  { id: 'palette.dismiss', bindings: ['Escape'], context: 'open command picker', description: 'Dismiss the picker through the active interaction owner.' },
]
