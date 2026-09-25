// Which keydowns in a terminal pane count as the user engaging with it, and so
// clear its unread marker (NEW badge, completion outline).
//
// WHY terminal panes need a filter at all: they acknowledge from a DOM
// keydown CAPTURE handler, because xterm mixes real keys and protocol replies
// in onData (see the leaves' WHY). A capture handler sees EVERY key pressed
// while the pane has focus, including the ones that navigate AWAY from it.
// Unfiltered, arrowing out of a terminal pane cleared the marker of the pane
// being left, which is the exact "passing through isn't seeing" case #1172
// forbids (PR #1176 review).
//
// Two kinds of keydown are not engagement:
//   - Keys the workspace keybinding router already handled. It listens on
//     `document` in the capture phase (useKeybinds), which runs before React's
//     root-level capture handlers, and it preventDefaults what it consumes.
//     So `defaultPrevented` is already set by the time the leaf sees the event.
//   - A bare modifier press. The Alt of Option+Arrow arrives as its own
//     keydown before the arrow, and the router doesn't consume it.
const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'CapsLock', 'Control', 'Fn', 'Meta', 'OS', 'Shift'])

export function isEngagementKeydown(event: { key: string; defaultPrevented: boolean }): boolean {
  return !event.defaultPrevented && !MODIFIER_KEYS.has(event.key)
}
