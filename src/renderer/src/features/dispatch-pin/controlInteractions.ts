import type { InteractionReference } from '@control-sdk'
export const pinInteractions: InteractionReference[] = [
  { id: 'pins.select', bindings: ['Up', 'Down', 'J', 'K'], context: 'Pin Agents dialog', description: 'Move the cursor through eligible agents.' },
  { id: 'pins.toggle', bindings: ['Space'], context: 'Pin Agents dialog', description: 'Toggle the current agent in the ordered pin selection.' },
  { id: 'pins.confirm', bindings: ['Enter', 'Escape'], context: 'Pin Agents dialog', description: 'Enter commits the selection; Escape dismisses the dialog.' },
]
