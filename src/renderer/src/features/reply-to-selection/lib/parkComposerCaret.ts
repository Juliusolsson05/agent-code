import type { SessionId } from '@renderer/workspace/types'

// Move a pane composer's caret to the end of its draft.
//
// WHY THIS IS NECESSARY, and why prompt templates do NOT need it:
//
//   `selectionStart` is a plain integer offset into the textarea value.
//   It is NOT recomputed when the value changes underneath it. Prompt
//   template insertion APPENDS (`draft + "\n\n" + body`), so every offset
//   into the user's existing text stays valid and the caret keeps
//   pointing at the same character it did before.
//
//   "Reply to Selection" PREPENDS. Every existing offset is now short by
//   the length of the quote block. A user with the caret at the end of
//   "hello" (offset 5) ends up with the caret 5 characters into
//   `<quoted-from-conversation note="The user sel…` — so their next
//   keystroke lands in the middle of the tag's attribute and corrupts
//   the quote they just inserted.
//
//   End-of-draft is the right destination rather than "5 + quote length"
//   (which would preserve their position): the entire point of the
//   command is that the user now types their reply BELOW the quote.
//
// WHY the rAF is load-bearing:
//   Setting `selectionStart` synchronously targets the textarea's OLD
//   React-bound value — the new draft has not re-rendered yet — so the
//   caret gets parked at a stale index and the whole fix silently does
//   nothing. This mirrors `usePasteToFocus.ts`, which carries the same
//   warning for the same reason. Do not "simplify" the rAF away.
//
// WHY a DOM query and not a ref:
//   The composer's ref is local to TileLeaf. A command-palette `run()`
//   receives only the workspace object and has no path to it. The
//   textarea stamps `data-composer-input={sessionId}` for exactly this.
//
// No-ops when the pane is not mounted (quoting from Reader Mode, or a
// session that has been detached). That is correct rather than a missed
// case: with no textarea on screen there is no caret to be wrong, and
// the composer re-mounts with the caret at the end anyway.
export function parkComposerCaretAtEnd(sessionId: SessionId): void {
  requestAnimationFrame(() => {
    // Session ids are uuid/`resume-…`-shaped (no quotes), so direct
    // interpolation into the attribute selector is safe — same as the
    // existing `[data-pane-id="…"]` lookups elsewhere in the app.
    const el = document.querySelector<HTMLTextAreaElement>(
      `[data-composer-input="${sessionId}"]`,
    )
    if (!el) return
    el.selectionStart = el.value.length
    el.selectionEnd = el.value.length
  })
}
