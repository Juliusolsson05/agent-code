import type { InteractionReference } from '@control-sdk'
export const workspaceInteractions: InteractionReference[] = [
  { id: 'placement.choose', bindings: ['Up', 'Down', 'Left', 'Right'], context: 'agent placement preview', description: 'Choose placement relative to the anchor pane.' },
  { id: 'placement.global', bindings: ['Shift+Up', 'Shift+Down', 'Shift+Left', 'Shift+Right'], context: 'agent placement preview', description: 'Choose placement relative to the whole project tab rather than its anchor pane.' },
  { id: 'placement.reset', bindings: ['Backspace'], context: 'agent placement preview', description: 'Return selection to the default placement for the anchor.' },
  { id: 'placement.confirm', bindings: ['Enter', 'Escape'], context: 'agent placement or Dispatch shape dialog', description: 'Enter confirms a valid selected placement/shape; Escape dismisses the owning dialog.' },
  { id: 'provider.select', bindings: ['Up', 'Down', 'Ctrl+P', 'Ctrl+N', 'Enter'], context: 'provider switch picker', description: 'Navigate provider choices and confirm the selected provider.' },
  { id: 'agent-view.select', bindings: ['Up', 'Down', 'Enter'], context: 'agent view-mode picker', description: 'Select and confirm the rendered/terminal view choice.' },
  { id: 'tabs.reorder', bindings: ['Up', 'Down', 'Enter'], context: 'reorder tabs dialog', description: 'Arrows browse until Enter picks a tab; subsequent arrows move that tab, and Enter confirms the reorder.' },
  { id: 'dialogs.confirm', bindings: ['Enter', 'Escape'], context: 'workspace prompts and dialogs', description: 'Confirm a valid form or dismiss the dialog according to its focused control. Read close/rewind impact before confirming.' },
]
