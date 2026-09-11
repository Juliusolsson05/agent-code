import { normalizeTextKey } from '@renderer/rendering/observations/committed'
import type { ReaderMessage } from '@renderer/features/reader/model/readerMessages'

// ---------------------------------------------------------------------------
// Which Reader message stays selected when the message list changes.
//
// WHY this is its own rule and not "keep the id if it still exists" (what
// ReaderView did until the PR #861 review):
//
// Reader's list comes from the render ledger (see readerMessages.ts), and the
// ledger reshapes it in two ways an id check cannot follow:
//
//   1. A live turn grows NEW pages. A Claude turn that writes text, calls a
//      tool, then writes more text produces a second `semantic-block` message.
//      A reader who was keeping up with the agent (sitting on the newest
//      message) has to be carried onto it, or Reader freezes on the first page
//      while the answer continues underneath.
//
//   2. A message changes id without changing content. A finished turn waits in
//      semantic history until its JSONL line lands (a soak bundle measured ~19s
//      of lag), then the ledger hands its text to the committed entry: the id
//      goes from `semantic-block:<turn>:<i>` to `entry:<uuid>`. Treating that
//      as "the message vanished" threw a reader who had paged back to it onto
//      the live end of the conversation.
//
// The old screen-sourced Reader never hit either case: its single `__live__`
// sentinel absorbed every live page, and every older message was a committed
// uuid that could not change. Those were properties of a sentinel that also
// painted Claude's background-agent panel as the answer (#855), so the rule has
// to be explicit now.
// ---------------------------------------------------------------------------

export type ReaderSelection = {
  id: string | null
  /** True when the reader is now looking at a DIFFERENT message, so the view
   *  should start it from the top. A handoff of the same text to its committed
   *  twin, or a message growing in place, is not a move: resetting the scroll
   *  there yanked the user out of the paragraph they were reading. */
  moved: boolean
}

export function nextReaderSelection(
  previous: readonly ReaderMessage[],
  previousId: string | null,
  next: readonly ReaderMessage[],
): ReaderSelection {
  const newest = next[next.length - 1]
  if (!newest) return { id: null, moved: previousId !== null }
  if (previousId === null) return { id: newest.id, moved: true }

  const previousIndex = previous.findIndex(message => message.id === previousId)
  const selected = previousIndex >= 0 ? previous[previousIndex]! : null

  // Following: the reader was on the newest message, so they stay on the
  // newest one — whether it grew in place, gained a next page, or was handed
  // to its committed twin. `continues` (not equality) because the last paint
  // may have shown a partial live block before the final text and its JSONL
  // entry landed in the same update.
  if (selected && previousIndex === previous.length - 1) {
    if (newest.id === previousId) return { id: previousId, moved: false }
    return { id: newest.id, moved: !continues(selected.text, newest.text) }
  }

  if (next.some(message => message.id === previousId)) return { id: previousId, moved: false }
  if (!selected) return { id: newest.id, moved: true }

  // The reader chose an older message and it changed id. Its committed twin
  // carries the same text — the ledger only hands text over on an exact or
  // normalised match (observations/semantic.ts textKey / normalizedTextKey) —
  // so find it by text. The same text can legitimately appear twice ("Done."),
  // so take the match nearest the old position, measured from the end because
  // that is the end the ledger appends to and the loaded window trims from.
  const distanceFromEnd = previous.length - 1 - previousIndex
  const selectedKey = normalizeTextKey(selected.text)
  let twin: ReaderMessage | null = null
  let twinGap = Number.POSITIVE_INFINITY
  next.forEach((message, index) => {
    if (normalizeTextKey(message.text) !== selectedKey) return
    const gap = Math.abs(next.length - 1 - index - distanceFromEnd)
    if (gap < twinGap) {
      twin = message
      twinGap = gap
    }
  })
  if (twin) return { id: (twin as ReaderMessage).id, moved: false }

  // No twin (a history turn evicted by the cap, an entry trimmed from the
  // window): hold the distance from the end so the reader stays near where they
  // were rather than being thrown to the live end.
  return { id: next[Math.max(0, next.length - 1 - distanceFromEnd)]!.id, moved: true }
}

function continues(before: string, after: string): boolean {
  return normalizeTextKey(after).startsWith(normalizeTextKey(before))
}
