import { useEffect } from 'react'

import { resolveQuoteScope } from '@renderer/features/reply-to-selection/lib/quoteScope'
import {
  clearPendingSelection,
  setPendingSelection,
} from '@renderer/features/reply-to-selection/lib/selectionStash'

// The single document-level selection listener behind "Reply to Selection".
//
// WHY one global listener and not one per pane:
//   `selectionchange` only fires on `document` — there is no
//   element-scoped variant. A per-pane hook would mean N listeners all
//   filtering the same global event. One listener that resolves the
//   owning scope from the anchor node is strictly less work, and it
//   makes Reader Mode participate for free (Reader Mode has no TileLeaf
//   to hang a per-pane hook on).
//
// MOUNT CONTRACT: mounted exactly once, from App.tsx. Mounting it twice
// is not corrupting (both copies compute the same stash writes) but it
// doubles the work on every drag.
export function useSelectionCapture(): void {
  useEffect(() => {
    function onSelectionChange(): void {
      const selection = document.getSelection()
      if (!selection) return

      const anchorScope = resolveQuoteScope(selection.anchorNode)

      // ── Collapsed selection ────────────────────────────────────────
      // This is where the design's central subtlety lives. A collapsed
      // selection has two very different causes that look identical
      // here, and they need opposite handling:
      //
      //   1. The user clicked inside the feed. They are done with the
      //      old selection — clear it, so the command stops offering a
      //      quote whose highlight is gone.
      //
      //   2. Focus moved to the command palette (or the composer). The
      //      browser collapses the selection as a side effect. The user
      //      is, in fact, *about to use* the selection — clearing here
      //      would break the one flow this whole feature exists for.
      //
      // The discriminator is whether the collapsed anchor is still
      // inside a quote scope. Case 1 leaves the caret in the feed, so it
      // resolves to a session and we clear. Case 2 moves the anchor into
      // the palette input (or drops it entirely), so it resolves to null
      // and we leave the stash alone.
      if (selection.isCollapsed) {
        if (anchorScope) clearPendingSelection(anchorScope)
        return
      }

      // ── Non-empty selection ────────────────────────────────────────
      // Require BOTH ends inside the same scope. A drag that starts in
      // one pane's feed and ends in another's would otherwise attribute
      // the whole range — including the other session's text — to
      // whichever end we happened to check.
      const focusScope = resolveQuoteScope(selection.focusNode)
      if (!anchorScope || anchorScope !== focusScope) return

      // `toString()` on the range gives the rendered text, which is what
      // the user actually sees and therefore what they mean to quote —
      // markdown source and syntax-highlight markup are correctly absent.
      const text = selection.toString()

      // Whitespace-only selections are what you get from a sloppy drag
      // across padding. Treated as no selection at all rather than
      // stashed, so the command does not appear armed with nothing.
      if (text.trim().length === 0) return

      setPendingSelection(anchorScope, text)
    }

    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])
}
