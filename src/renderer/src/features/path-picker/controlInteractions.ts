import type { InteractionReference } from '@control-sdk'
export const pathInteractions: InteractionReference[] = [
  { id: 'paths.navigate', bindings: ['Up', 'Down', 'Tab'], context: 'directory/path input', description: 'Move through suggestions and complete the selected path.' },
  { id: 'paths.confirm', bindings: ['Enter', 'Escape'], context: 'directory/path input', description: 'Confirm the selected path or dismiss its suggestion/picker interaction.' },
]
