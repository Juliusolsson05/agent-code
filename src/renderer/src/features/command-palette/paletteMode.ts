// ---------------------------------------------------------------------------
// The palette's sub-mode.
//
// WHY this type lives in its own module rather than beside the component that
// renders it: the mode is STORE state (see `uiShell.paletteMode`), and
// `app-state/uiShell/types.ts` needs the type. Importing it from
// `command-palette/types.ts` would drag the whole `CommandContext` graph —
// which reaches the workspace store — into the app-state layer that
// `CommandContext` itself depends on. A five-line module breaks the cycle.
//
// WHY the mode is store state at all, when it was `useState` on the palette
// component for most of this app's life: a chord does not open the palette. It
// sets a pending invocation, which mounts the palette INVISIBLY, runs the
// command, and unmounts it in the same commit. Any mode a command set with
// `setMode` was therefore written to a component that was already invisible and
// about to be destroyed — nine commands (Resume Session, Prompt Template, the
// buried pair, the three AI-workspace ones, and two prompt-template siblings)
// were silent no-ops from every source except the palette itself, two of them
// with shipped default chords.
//
// Store state has no lifecycle tied to the component, so it cannot be lost that
// way. That is the whole argument; there is no ordering subtlety to get wrong.
// ---------------------------------------------------------------------------

export type PaletteMode =
  | 'commands'
  | 'resume'
  | 'buried'
  | 'kill-buried'
  | 'prompt-template'
  | 'manage-prompt-template'
  | 'fill-prompt-template'
  | 'save-prompt-template'
  | 'edit-prompt-template'
  | 'ai-workspace-open'
  | 'ai-workspace-create'
  | 'ai-workspace-clear'

/** The mode a freshly-opened palette starts in. Also what closing resets to —
 *  reopening should never resume a half-finished sub-flow. */
export const DEFAULT_PALETTE_MODE: PaletteMode = 'commands'
