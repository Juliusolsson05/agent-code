import type { InteractionReference } from '@control-sdk'
export const workspaceInteractions: InteractionReference[] = [
  // The New Agent picker's geometric placement step (arrows, Shift+arrows,
  // Backspace relative to an anchor pane) was deleted with the tile tree
  // (#992). The picker is one screen now, and an external agent reading this
  // reference must not be told to press keys that do nothing (#1013 review B).
  { id: 'new-agent.select', bindings: ['Up', 'Down', 'Enter', 'Escape'], context: 'New Agent picker', description: 'Choose the agent type; Enter creates it. It fills the focused lane when that lane is empty, and otherwise waits in the project index. Escape dismisses.' },
  { id: 'placement.confirm', bindings: ['Enter', 'Escape'], context: 'lane grid shape dialog', description: 'Enter confirms a valid shape; Escape dismisses the dialog.' },
  { id: 'provider.select', bindings: ['Up', 'Down', 'Ctrl+P', 'Ctrl+N', 'Enter'], context: 'provider switch picker', description: 'Navigate provider choices and confirm the selected provider.' },
  { id: 'new-agent-in.select', bindings: ['Up', 'Down', 'Ctrl+P', 'Ctrl+N', 'Enter', 'Backspace'], context: 'New Agent In dialog', description: 'Choose the agent, then the project; Enter advances, then creates the agent in the focused Dispatch lane (or as a new Dispatch row); Backspace returns to the agent step.' },
  { id: 'agent-view.select', bindings: ['Up', 'Down', 'Enter'], context: 'agent view-mode picker', description: 'Select and confirm the rendered/terminal view choice.' },
  { id: 'tabs.reorder', bindings: ['Up', 'Down', 'Enter'], context: 'reorder tabs dialog', description: 'Arrows browse until Enter picks a tab; subsequent arrows move that tab, and Enter confirms the reorder.' },
  { id: 'dialogs.confirm', bindings: ['Enter', 'Escape'], context: 'workspace prompts and dialogs', description: 'Confirm a valid form or dismiss the dialog according to its focused control. Read close/rewind impact before confirming.' },
]
