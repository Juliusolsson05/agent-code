import type { SessionId } from '@renderer/workspace/types'

// Pending-selection stash — a SINGLE slot, carrying its own session id.
//
// WHY THIS EXISTS AT ALL (the load-bearing fact of this feature):
//   The "Reply to Selection" command is invoked from the command
//   palette. The palette is an input; focusing it makes Chrome collapse
//   the document selection. So by the time the command's `when:` guard
//   runs — let alone its `run()` — `window.getSelection()` is empty.
//   Reading the live selection at command time CANNOT work.
//
//   So the selection is captured while the user is still dragging (see
//   useSelectionCapture.ts) and parked here. The command reads this,
//   never the DOM.
//
//   If a future change "simplifies" this by calling window.getSelection()
//   inside run(), the command will silently insert nothing. That is the
//   bug this module exists to prevent.
//
// WHY ONE SLOT AND NOT A MAP KEYED BY SESSION:
//   A document has exactly one selection. If the user selects in pane A
//   and then selects in pane B, A's highlight is *gone from the screen* —
//   keeping a stash for it would let the command offer a quote the user
//   can no longer see, which is precisely the confusion this feature is
//   supposed to avoid. One slot mirrors the browser's own model.
//
//   It also fixes targeting. The obvious implementation resolves the
//   target session from `commandTargetSessionId`, but that follows
//   grid/Dispatch focus — and Reader Mode maintains its OWN session
//   selection (`workspace.setReaderModeSession`). Quoting in Reader Mode
//   would then insert into whichever session the hidden grid happened to
//   be focused on. Carrying the session id alongside the text makes the
//   target unambiguous: it is the session whose feed the text came from,
//   by construction.
//
// WHY module-scope and not SessionRuntime:
//   `draftInput` lives in runtime because it must survive TileLeaf
//   unmount and be persisted as a draft. A pending selection is neither
//   of those things — it is ephemeral and DOM-derived, and it must never
//   be autosaved or rehydrated (resuming a session with a stale "pending
//   quote" from last week would be a bug, not a feature). Runtime writes
//   also bump setDraftVersion, which would dirty the autosave path on
//   every mouse drag. codeBlockRegistry.ts sets the precedent for
//   DOM-derived data living in module scope.
//
//   The reactivity we give up is not needed: the palette evaluates
//   `when:` when it builds its list, which is always AFTER the selection
//   was made.

export type PendingSelection = {
  /** The session whose feed this text was selected from. This — not the
   *  focused pane — is the session the quote is inserted into. */
  sessionId: SessionId
  text: string
}

let pending: PendingSelection | null = null

export function setPendingSelection(sessionId: SessionId, text: string): void {
  pending = { sessionId, text }
}

/**
 * Clear the slot, whoever owns it.
 *
 * WHY THERE IS NO OWNERSHIP CHECK (this was a bug, and the fix is
 * counter-intuitive enough to be worth the paragraph):
 *
 *   An earlier version only cleared when the slot's `sessionId` matched
 *   the scope the collapse happened in, reasoning that a click in pane B
 *   should not evict a selection made in pane A. That is exactly wrong,
 *   and it contradicts the single-slot invariant above.
 *
 *   There is ONE document selection. Selecting in A and then clicking in
 *   B means A's highlight is already gone from the screen — the click in
 *   B *is* what destroyed it. Keeping A's entry left the command armed
 *   and pointed at A while the user was looking at B, so running it
 *   edited a draft the user was not even looking at.
 *
 *   The slot mirrors the browser's selection. When that selection is
 *   destroyed, the slot goes with it, regardless of which pane the
 *   destroying event landed in.
 */
export function clearPendingSelection(): void {
  pending = null
}

/**
 * Non-destructive read. Used by the command's `when:` guard and to build
 * the badge snippet — neither should consume the selection, because the
 * palette can be opened and dismissed without running anything.
 */
export function peekPendingSelection(): PendingSelection | null {
  return pending
}

/**
 * Read-and-clear. This is the ONLY path the command's `run()` uses.
 *
 * WHY read-and-clear in one call: "consume on use" (so the command stops
 * offering a quote the user already inserted) and "a second run replaces
 * rather than stacks" are two halves of the same rule. Splitting them
 * into a separate peek + clear is how they drift apart — a `run()` that
 * forgets to clear leaves the command armed with text now sitting in the
 * composer.
 */
export function takePendingSelection(): PendingSelection | null {
  const taken = pending
  pending = null
  return taken
}
