import { useEffect } from 'react'

import { isInsideMonacoEditor, resolveQuoteScope } from '@renderer/features/reply-to-selection/lib/quoteScope'
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
//
// ─────────────────────────────────────────────────────────────────────
// THE RULE (read this before changing any branch below)
//
//   1. A valid in-scope, non-empty selection            → STASH it.
//   2. A COLLAPSED selection OUTSIDE every quote scope  → KEEP the stash.
//   3. Everything else                                  → CLEAR the stash.
//
// Rule 2 is the entire reason this feature works, and it looks like a
// bug until you know why. The command is invoked from the command
// palette; the palette is an input, and focusing it makes Chrome
// collapse the document selection onto <body>. That collapse lands
// outside every scope. If it cleared, the stash would be empty by the
// time the user could possibly run the command — the feature would
// never work at all.
//
// Rule 3 is the default *because the stash mirrors the browser's single
// document selection*. Any event that leaves us without a valid in-scope
// selection means the highlight the user was looking at is gone, so the
// stash must go too. An earlier version returned early on several of
// these paths instead of clearing, which left the command armed with
// text whose highlight had vanished — including, in the cross-pane case,
// pointed at a session the user was no longer looking at.
//
// Concretely, rule 3 covers: a click that places a caret in a feed (any
// feed, not just the stashed one), a new selection made outside any
// scope such as in the composer, a whitespace-only drag across padding,
// and a drag whose two ends land in different scopes.
// ─────────────────────────────────────────────────────────────────────
export function useSelectionCapture(): void {
  useEffect(() => {
    function onSelectionChange(): void {
      const selection = document.getSelection()
      if (!selection) return

      // Monaco owns its own regions — defer entirely. Its internal focus
      // handling emits document-selection events that describe the hidden
      // textarea, not what the user highlighted, so acting on them would
      // clear a stash the Monaco bridge legitimately set.
      if (isInsideMonacoEditor(selection.anchorNode)) return

      const anchorScope = resolveQuoteScope(selection.anchorNode)

      if (selection.isCollapsed) {
        // Rule 2 vs rule 3, discriminated by whether the caret landed
        // inside a quote scope. Out-of-scope collapse is the palette (or
        // composer) taking focus — the user is about to USE the
        // selection, so it survives. In-scope collapse is a real click in
        // a feed, which is the user destroying their own selection.
        if (anchorScope) clearPendingSelection()
        return
      }

      // Both ends must be in the SAME scope. A drag spanning two panes
      // would otherwise attribute the whole range — including the other
      // session's text — to whichever end we happened to sample. It also
      // must be cleared rather than ignored: intermediate `selectionchange`
      // events during the drag already stashed the in-scope prefix, so
      // returning early here would leave a stash holding LESS text than
      // the user can see highlighted.
      const focusScope = resolveQuoteScope(selection.focusNode)
      if (!anchorScope || anchorScope !== focusScope) {
        clearPendingSelection()
        return
      }

      // `toString()` gives the rendered text, which is what the user
      // actually sees and therefore what they mean to quote — markdown
      // source and syntax-highlight markup are correctly absent.
      const text = selection.toString()

      // A whitespace-only drag across padding is not a selection the user
      // meant to make. Clear rather than stash, so the command never
      // appears armed with nothing.
      if (text.trim().length === 0) {
        clearPendingSelection()
        return
      }

      setPendingSelection(anchorScope, text)
    }

    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])
}
