import type { UiShellState } from '@renderer/app-state/uiShell/types'

// ---------------------------------------------------------------------------
// Which command owns which on-screen surface.
//
// THE PROBLEM. `useKeybinds` bails out of the entire key handler when
// `hasAppInteractionOwner()` is true, and every Radix `DialogContent` stamps
// that marker. The gate is correct and load-bearing: without it, ⌘W closes a
// pane behind an open confirmation dialog. But it also means a surface built as
// a dialog makes ITS OWN chord unreachable while it is open — press ⌘⇧U to open
// Usage, press it again, nothing happens, because the router never reaches the
// binding index.
//
// That is why some chords round-trip today and some do not, and the split has
// nothing to do with the commands: ⌥R Reader and ⌥S Spotlight work because they
// render inline in MainSurface, Agent Status works because it is a plain
// `<aside>`, and Usage / the palette / Remote Panel fail because they are
// dialogs. No change confined to a `commands/*.ts` file can fix that.
//
// THE NARROW EXEMPTION. A chord may cross the gate when it maps to the command
// that owns the surface currently holding the interaction. Pressing ⌘⇧U while
// Usage is up is unambiguously "dismiss Usage" — it cannot be a stray shortcut
// leaking into a modal, because the modal is the thing the command controls.
// Everything else still bails.
//
// WHY A TABLE, and not `command.getState(ctx)?.value === 'on'`, which would be
// derived and unable to drift: evaluating `getState` needs a `CommandContext`,
// and building one assembles ~76 workspace actions. Deferring exactly that cost
// is the entire reason the router forwards an id through
// `requestCommandInvocation` instead of dispatching inline (#494). Paying it on
// every keystroke that lands while a dialog is open would be a real regression
// to fix a keyboard nicety.
//
// The drift risk is bounded by types: the value is `keyof UiShellState`, and the
// Phase 4 commands read the SAME flag through `CommandContext.flags`. A typo is
// a compile error, and a surface whose flag is renamed breaks here loudly.
//
// WHAT DOES NOT BELONG HERE. Only surfaces whose command should DISMISS them on
// a second press. Not per-target pickers (re-pressing with a different target
// should re-target, not close), not surfaces that write something on the way in
// (Save Debug Logs, Attach Recording Note — a second press legitimately writes a
// second one), and not the Settings page, which is a destination rather than a
// peek.
// ---------------------------------------------------------------------------

/**
 * Command id → the uiShell flag whose truth means "my surface is on screen".
 *
 * Presence in this table is a claim with teeth: it lets the command's chord
 * cross the interaction-owner gate. Add an entry only when a second press
 * genuinely means dismiss.
 */
export const SURFACE_OWNER_FLAGS = {
  'usage.open': 'usageModalOpen',
  'open-keyboard-shortcuts': 'keyboardShortcutsOpen',
  'open-agent-activity': 'agentActivityOpen',
  'close-old-agents': 'closeOldAgentsOpen',
  'switch-agents-provider': 'bulkProviderSwitchOpen',
  'search-conversation-prompts': 'promptSearchOpen',
  'toggle-remote-panel': 'remotePanelOpen',
  'reorder-tabs': 'reorderTabsOpen',
  'pin-agents': 'pinAgentsOpen',
  'new-tab': 'pathPickerOpen',
} as const satisfies Record<string, keyof UiShellState>

export type SurfaceOwningCommandId = keyof typeof SURFACE_OWNER_FLAGS

/**
 * Is this command the owner of a surface that is open right now?
 *
 * Takes the store snapshot rather than reading it, so the caller controls when
 * the read happens and this stays a pure predicate.
 */
export function commandOwnsOpenSurface(
  commandId: string,
  state: Pick<UiShellState, (typeof SURFACE_OWNER_FLAGS)[SurfaceOwningCommandId]>,
): boolean {
  const flag = SURFACE_OWNER_FLAGS[commandId as SurfaceOwningCommandId]
  if (!flag) return false
  return state[flag] === true
}
