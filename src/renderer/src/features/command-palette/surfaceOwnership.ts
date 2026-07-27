import type { UiShellState } from '@renderer/app-state/uiShell/types'
import type { PaletteMode } from '@renderer/features/command-palette/paletteMode'

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
//
// `new-tab` was listed here and has been REMOVED. `pathPickerOpen` does not
// mean "the new-tab picker is open", it means "the shared path modal is open" —
// the same modal the resume flow opens with a pre-filled cwd. So the boolean
// loses exactly the information the nine session-scoped surfaces were kept out
// for. Two live consequences settled it: `PathPickerSurface` awaits
// `workspace.newTab(...)` before closing, so during a slow spawn ⌘T dismissed
// the picker mid-submit; and a create action had started rendering an
// Open/Closed badge, which is not what New Tab is.
//
// `open-command-palette` is also absent, for a different reason: a blind toggle
// makes a double-tap flicker the surface. The useful second-press behavior is
// "if in a sub-mode, return to the command list; close only when already
// clean", which Escape's back-out ladder already provides. Revisit that as its
// own change rather than folding it in here.
// ---------------------------------------------------------------------------

/**
 * Only the BOOLEAN fields of the store.
 *
 * `keyof UiShellState` was not enough, and the module claimed a safety it did
 * not have: it accepts any of ~40 keys, so `'view-prompts': 'viewPromptsSessionId'`
 * compiled — and `state[flag] === true` against a `SessionId | null` is
 * permanently false, which is silent. The chord stops being exempt, the surface
 * becomes undismissable again, and nothing fails. Narrowing the type is what
 * makes "a typo is a compile error" true rather than aspirational.
 */
type BooleanUiShellFlag = {
  [K in keyof UiShellState]: UiShellState[K] extends boolean ? K : never
}[keyof UiShellState]

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
} as const satisfies Record<string, BooleanUiShellFlag>

export type SurfaceOwningCommandId = keyof typeof SURFACE_OWNER_FLAGS

/**
 * Command id → the palette sub-mode it owns.
 *
 * A SECOND table rather than more rows in the first, because the two express
 * different things and the first attempt at merging them showed it: these
 * commands do not own a surface with its own visibility flag — they own a MODE
 * of one shared surface. Keying them on `commandPaletteOpen` type-checked and
 * was wrong in a way a test caught immediately: it implied each should carry an
 * Open/Closed badge, when "the palette is open" is not a property of Resume
 * Session.
 *
 * The chord is admitted whenever the palette is open — deliberately wider than
 * dismissal, so pressing ⌥P while the palette sits in Resume mode SWITCHES to
 * prompt templates instead of being swallowed. The command compares
 * `flags.paletteMode` against its own entry here and decides; this table only
 * decides whether it gets the chance.
 */
export const PALETTE_MODE_COMMANDS = {
  'resume-session': 'resume',
  'revive-pane': 'buried',
  'kill-buried-pane': 'kill-buried',
  'prompt-template': 'prompt-template',
  'manage-prompt-templates': 'manage-prompt-template',
  'save-composer-as-prompt-template': 'save-prompt-template',
  'open-ai-workspace': 'ai-workspace-open',
  'create-ai-workspace': 'ai-workspace-create',
  'clear-ai-workspace': 'ai-workspace-clear',
} as const satisfies Record<string, PaletteMode>

/**
 * Is this command the owner of a surface that is open right now?
 *
 * Takes the store snapshot rather than reading it, so the caller controls when
 * the read happens and this stays a pure predicate.
 */
export function commandOwnsOpenSurface(
  commandId: string,
  state: Pick<
    UiShellState,
    (typeof SURFACE_OWNER_FLAGS)[SurfaceOwningCommandId] | 'commandPaletteOpen'
  >,
): boolean {
  // A palette-mode command owns the palette whenever it is open, whatever mode
  // it currently shows — see PALETTE_MODE_COMMANDS for why that is wider than
  // strict dismissal.
  if (commandId in PALETTE_MODE_COMMANDS) return state.commandPaletteOpen === true

  const flag = SURFACE_OWNER_FLAGS[commandId as SurfaceOwningCommandId]
  if (!flag) return false
  return state[flag] === true
}
