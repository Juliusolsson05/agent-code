import type { SessionId } from '@renderer/workspace/types'

// The Reader's currently selected assistant message: the keyboard source for
// "Reply to Reader Message" (ledger K2-4).
//
// WHY this exists: Reply to Selection quotes a DOM text selection, and a
// keyboard user cannot make one in Electron without caret browsing, so
// quoting was mouse-only. Reader Mode already selects one whole assistant
// message from the keyboard (⌥↑ / ⌥↓, "Older / Newer"). Publishing that
// selection lets a palette command quote it. The palette is the way in, and
// its `when` / `run` run outside ReaderView, which is why the selection
// cannot stay in ReaderView's local state.
//
// WHY module scope, like selectionStash.ts: this is ephemeral view state.
// It must never be autosaved or rehydrated, and reactivity is not needed,
// because the palette reads it when it builds its list, after the reader
// has shown the message.
//
// WHY it carries the sessionId: the quote must land in the agent being READ,
// which Reader tracks on its own (setReaderModeSession) and which can differ
// from the hidden grid's focused pane.

export type ReaderMessage = { sessionId: SessionId; messageId: string; text: string }

let current: ReaderMessage | null = null

export function setReaderMessage(message: ReaderMessage | null): void {
  current = message
}

/** Clear only if the slot still belongs to `sessionId`: an unmounting
 *  ReaderBody for agent A must not wipe what agent B's body just published
 *  when the reader switches between them in one commit. */
export function clearReaderMessage(sessionId: SessionId): void {
  if (current?.sessionId === sessionId) current = null
}

export function peekReaderMessage(): ReaderMessage | null {
  return current
}
