import type { InteractionReference } from '@control-sdk'

// Same keys as the file explorer's context menu (editor.context-menu): the
// platform conventions for "open this item's menu from the keyboard".
export const sessionContextMenuInteractions: InteractionReference[] = [
  { id: 'sessions.context-menu', bindings: ['ContextMenu', 'Shift+F10'], context: 'Sessions list row', description: 'Open the row’s agent menu, anchored to the row. Arrow keys and type-to-select then navigate the native menu.' },
]
