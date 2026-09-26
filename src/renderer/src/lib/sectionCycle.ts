import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

// ⌘[ / ⌘] cycle the SECTIONS of a sectioned dialog (keyboard-first plan D5):
// Usage's provider rail, Agent Analytics' views, Performance's tabs,
// Settings' categories. Agreed with B7 as the second opinion.
//
// WHY ⌘[ / ⌘]: they already mean "previous / next tab" app-wide, and
// `useKeybinds` blocks them from the workspace while a modal owns input
// (BLOCKED_META_CODES) — preventDefault only, so the event still reaches the
// dialog's own handler. The dialog giving them the same meaning ("previous /
// next section of the thing in front of me") keeps one mental model instead
// of teaching a second chord (⌃Tab was the alternative).
//
// WHY it yields inside code and multiline text (B7's condition): in Monaco
// and in a textarea ⌘[ / ⌘] are OUTDENT / INDENT. Stealing them there would
// break editing in the exact dialogs (Theme editor JSON, Conventions) where
// the user is most likely to be using them. A single-line input has no such
// meaning, so the chord still cycles from a search field.
//
// Returns the section index to go to, or null when the event is not a
// section-cycle chord for this context. The caller moves the section and
// calls preventDefault — keeping state in the caller, where it already lives.
export function sectionCycleTarget(
  event: ReactKeyboardEvent | KeyboardEvent,
  index: number,
  count: number,
): number | null {
  if (count <= 1) return null
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  // `code`, not `key`: on some layouts ⌥-less ⌘[ still reports a different
  // `key`, and the app's keybinding grammar reads physical codes too.
  const delta = event.code === 'BracketLeft' ? -1 : event.code === 'BracketRight' ? 1 : 0
  if (delta === 0) return null
  if (ownsBracketChord(event.target)) return null
  // Wraps: sections are a short cycle, like tabs (APG tablist), not a list.
  return ((index + delta) % count + count) % count
}

function ownsBracketChord(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLTextAreaElement) return true
  if (target.isContentEditable) return true
  // Monaco's hidden input is a textarea, but guard its container too so a
  // future Monaco version focusing a different node still yields.
  return target.closest('.monaco-editor') !== null
}
