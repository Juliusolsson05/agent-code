import type { KeybindingEvent } from '../keybindings.js'

// Sent exclusively by the application main process, never by a child frame.
// URL includes a parent-minted per-document nonce so a delayed native event
// cannot select or invoke commands on a replacement view at the same element.
export type ExtensionNativeInput =
  | { kind: 'focus'; url: string }
  | { kind: 'key'; url: string; type: 'keydown' | 'keyup'; input: KeybindingEvent & { repeat: boolean; isComposing: boolean } }

export type ExtensionInputBindings = { pane: string[]; modal: string[] }
