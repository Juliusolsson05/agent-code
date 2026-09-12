import type { InteractionReference } from '@control-sdk'
export const editorInteractions: InteractionReference[] = [
  { id: 'editor.quick-open', bindings: ['Up', 'Down', 'Enter', 'Escape'], context: 'file quick-open/search overlay', description: 'Move through matches, open the selected file/result, or dismiss the overlay.' },
  { id: 'editor.explorer', bindings: ['Up', 'Down', 'Left', 'Right', 'Home', 'End'], context: 'file explorer tree', description: 'Navigate tree entries; expand/collapse directories and move to the first/last visible entry.' },
  { id: 'editor.context-menu', bindings: ['ContextMenu', 'Shift+F10'], context: 'file explorer item', description: 'Open the item’s context menu. Arrow/Home/End keys then navigate that menu.' },
  { id: 'editor.rename', bindings: ['Enter', 'Escape'], context: 'file explorer rename/create input', description: 'Confirm or cancel the in-progress filename edit.' },
  { id: 'editor.native-keymap', bindings: [], context: 'embedded Monaco editor', description: 'Monaco also owns its editing/action keymap. Command/default and native reservation rows cover app integration; editor/provider extensions may add their own version-dependent bindings.' },
]
