import { useAgentTerminalOwnerVisible } from '@renderer/workspace/terminal/AgentTerminalOwnership'

// "May this pane own keyboard input right now?" (#752)
//
// WHY this is derived from the composed visibility CONTEXT and not from a
// store flag: the workspace subtree is retained under display:none by two
// different shells — Global Editor fullscreen (GlobalEditorWorkspaceSlot) and
// the Reader/Spotlight/Settings takeover (RetainedWorkspaceSurface) — and
// each one provides the same context, ANDed with its parent. A pane inside
// either shell therefore sees `visible === false`; a pane rendered OUTSIDE
// them (Spotlight's own leaf, which lives beside the shell) sees the default
// `true` even while the editor is fullscreen. Reading the editor store's
// `editorFullscreen` flag instead would be global, not scoped: the first cut
// of this did that and made Spotlight's visible leaf refuse Enter/y/n on an
// approval strip whenever the editor was fullscreen underneath.
//
// WHY "focused" alone is not enough: the retained tree keeps the active
// tab's focused leaf mounted AND focused while another surface owns the
// screen. Every document-level router — type-to-focus, paste-to-focus, the
// bare-Enter submit target, the dictation hotkey, the condition outlet —
// used to be unreachable because the leaf did not exist; now it must be told
// that a hidden focused pane owns nothing.
export function useInteractiveOwnership(focused: boolean): { interactive: boolean; hidden: boolean } {
  const visible = useAgentTerminalOwnerVisible()
  return { interactive: focused && visible, hidden: !visible }
}

// WHY refocus-on-reveal must check where focus currently is: a takeover
// surface unmounting leaves DOM focus on <body>, so pulling it back into the
// pane restores what the remount used to do for free. Editor fullscreen
// exit is different — the user is in Monaco, presses Escape (or "Split"),
// and the pane becoming visible again must NOT steal the caret out of the
// file they are editing. Only an unowned focus is ours to take.
export function focusIsUnowned(): boolean {
  const active = document.activeElement
  return active === null || active === document.body
}
