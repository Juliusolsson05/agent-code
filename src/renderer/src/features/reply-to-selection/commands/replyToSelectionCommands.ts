import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import type { CommandDef } from '@renderer/features/command-palette/types'
import { prefixDraftWithQuote, quoteSnippet } from '@renderer/features/reply-to-selection/lib/formatQuote'
import { parkComposerCaretAtEnd } from '@renderer/features/reply-to-selection/lib/parkComposerCaret'
import { value } from '@renderer/features/command-palette/commandState'
import {
  peekPendingSelection,
  takePendingSelection,
} from '@renderer/features/reply-to-selection/lib/selectionStash'
import type { PendingSelection } from '@renderer/features/reply-to-selection/lib/selectionStash'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// Validate a stashed selection against current workspace state.
//
// WHY the target is NOT commandTargetSessionId: the quote belongs to the
// session whose feed the text came from, which the stash records. Using
// focus instead would misfire in Reader Mode, where the reader keeps its
// own session selection independent of grid/Dispatch focus.
//
// Two things still have to be checked, because the stash is module state
// that outlives any given render: the session must still exist (it could
// have been closed between the drag and the palette), and it must not be
// a terminal (no composer draft to insert into, and xterm owns its own
// selection model rather than the DOM this feature captures from).
function validPendingSelection(workspace: Workspace): PendingSelection | null {
  const pending = peekPendingSelection()
  if (!pending) return null
  const meta = workspace.state.sessions[pending.sessionId]
  if (!meta) return null
  if ((meta.kind ?? DEFAULT_PROVIDER) === 'terminal') return null
  return pending
}

export const replyToSelectionCommands: CommandDef[] = [
  {
    id: 'reply-to-selection',
    category: 'session',
    surface: 'session',
    // Stable noun phrase per docs/command-style.md rule 1 — the captured
    // text is surfaced through `getState` as a badge (rule 3), not baked
    // into the title.
    title: 'Reply to Selection',
    description: '**What it does:** Prefixes the composer with the text you highlighted in the feed, wrapped in a tag that tells the agent you are replying to it.\n\n**Use when:** You want to respond to one specific line rather than the whole turn.\n\n**Notes:** Only appears when there is a highlighted selection. Your existing draft is kept below the quote; nothing is sent.',
    keywords: ['reply', 'quote', 'selection', 'highlight', 'respond', 'cite'],
    // NO `renderedViewPolicy` — deliberately, and it is worth knowing why
    // before adding one back.
    //
    // `renderedViewAvailable` in the registry evaluates the policy against
    // `commandTargetSessionId`, i.e. GRID/DISPATCH focus. This command
    // targets the session recorded in the stash instead, precisely because
    // those two disagree in Reader Mode. Declaring a policy therefore gated
    // visibility on a *different session* than the one being acted on:
    // with Reader Mode open on B while the hidden grid focus sat on A in
    // hard Terminal mode, the command vanished even though B rendered
    // fine and the user had just highlighted text in it.
    //
    // No policy is needed anyway, because the gate is self-enforcing: a
    // stash can only exist if the user selected text inside a rendered
    // `[data-quote-scope]` region. A surface that never rendered cannot
    // produce one. `validPendingSelection` covers the rest (session still
    // open, not a terminal).
    when: ({ workspace }) => validPendingSelection(workspace) !== null,
    getState: ({ workspace }) => {
      const pending = validPendingSelection(workspace)
      if (!pending) return null
      // The snippet is what stops this being a blind action: availability
      // comes from the stash, not from a highlight that is still visible
      // (opening the palette collapses it). See selectionStash.ts.
      // The stashed snippet is CONTEXT — it says what the command would quote.
      // Rendered with accent tone it read as "this toggle is on".
      return value(`"${quoteSnippet(pending.text, 40)}"`)
    },
    run: ({ workspace }) => {
      // Re-validate before consuming: `when` ran when the palette built
      // its list, and the session could have closed while it was open.
      if (!validPendingSelection(workspace)) return

      // Read-and-clear: consuming here is what makes a second run replace
      // rather than stack, and what stops the command staying armed with
      // text that is now sitting in the composer.
      const pending = takePendingSelection()
      if (!pending) return

      const currentDraft = workspace.getRuntime(pending.sessionId).draftInput
      const { draft, truncated } = prefixDraftWithQuote(currentDraft, pending.text)

      // Insertion stops at the draft boundary — same contract as prompt
      // template insertion. The user still presses Enter themselves.
      workspace.setDraftInput(pending.sessionId, draft)

      // Prepending invalidates every caret offset into the old draft, so
      // the caret has to be moved or the user's next keystroke lands
      // inside the quote tag. See parkComposerCaret.ts.
      parkComposerCaretAtEnd(pending.sessionId)

      workspace.showPaneToast(
        pending.sessionId,
        truncated ? 'Quoted selection (truncated)' : 'Quoted selection',
      )
    },
  },
]
