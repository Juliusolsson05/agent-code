import type { InteractionReference } from '@control-sdk'

// WHY this is beside composer input ownership, not in MCP: the same key has
// different meanings in local draft, slash-picker and native provider modes.
// Update these explanations with useComposerKeybinds, not the protocol adapter.
export const composerInteractions: InteractionReference[] = [
  { id: 'composer.submit', bindings: ['Enter'], context: 'rendered composer', description: 'Submit the current draft through the provider readiness/delivery gate; slash mode confirms the provider picker instead.' },
  { id: 'composer.newline', bindings: ['Shift+Enter'], context: 'normal rendered composer', description: 'Insert a newline into the local draft without sending it.' },
  { id: 'composer.escape', bindings: ['Escape'], context: 'rendered composer', description: 'In slash mode dismiss the native picker. When blocked by an occupied provider composer, clear that composer through its supported clearing routine; otherwise forward Escape only when backend input is ready.' },
  { id: 'composer.interrupt', bindings: ['Ctrl+C'], context: 'ready rendered composer', description: 'Forward interrupt and clear the local draft. Readiness gates can refuse the backend write.' },
  { id: 'composer.eof', bindings: ['Ctrl+D'], context: 'ready rendered composer', description: 'Forward EOF to the provider; its effect depends on the native runtime.' },
  { id: 'composer.history', bindings: ['Up', 'Down'], context: 'empty composer or active prompt-history cycling', description: 'Cycle local prompt history from an empty draft. With ordinary draft text, arrows retain editing behavior. Provider approval/slash interactions can own these keys instead.' },
  { id: 'composer.slash', bindings: ['/'], context: 'empty ready composer', description: 'Enter the native provider slash interaction; arrows, Enter, Escape, Backspace and Tab are routed according to that mode.' },
  { id: 'composer.tab', bindings: ['Tab'], context: 'rendered composer', description: 'On an empty normal draft, accept an app prompt suggestion without submitting. OpenCode may receive Tab to cycle its native agent; slash mode uses native completion.' },
  { id: 'composer.slash-navigation', bindings: ['Up', 'Down', 'Left', 'Right', 'Backspace', 'Tab'], context: 'native slash interaction', description: 'Navigate/edit the provider-owned slash interaction rather than invoking workspace navigation.' },
]
