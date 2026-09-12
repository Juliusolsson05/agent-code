import { normalizeTextKey } from '@renderer/rendering/observations/committed'
import type { ReaderMessage } from '@renderer/features/reader/model/readerMessages'

// ---------------------------------------------------------------------------
// Which Reader message stays selected when the message list changes.
//
// WHY this is its own rule and not "keep the id if it still exists" (what
// ReaderView did until the PR #861 review):
//
// Reader's list comes from the render ledger (see readerMessages.ts), and the
// ledger reshapes it in ways an id check cannot follow:
//
//   1. A live turn grows NEW pages. A Claude turn that writes text, calls a
//      tool, then writes more text produces a second `semantic-block` message.
//      A reader who is keeping up with the agent has to be carried onto it, or
//      Reader freezes on the first page while the answer continues underneath.
//
//   2. A message changes id without changing content. A finished turn waits in
//      semantic history until its JSONL line lands (a soak bundle measured ~19s
//      of lag), then the ledger hands it to the committed entry: the id goes
//      from `semantic-block:<turn>:<i>` to `entry:<uuid>`. For Claude that
//      handoff is by identity (committed `message.id` == turn id), so one
//      joined entry can replace several pages at once, and its text equals none
//      of them.
//
//   3. Position is not recency. The ledger stamps every block of the current
//      turn with the turn's start time and a committed line with its own later
//      time, so block 0's entry can sort BELOW the still-streaming block 2.
//      "The last message in the list" is therefore not "the newest content",
//      and a rule that follows the list's end pulls the reader backwards.
//
// So the rule follows only onto a genuinely new SEMANTIC page (see
// `newPages`), and only for a reader who is actually following — the view's
// stick-to-bottom state, which is set when the reader lands on a growing
// message and cleared when they scroll away or land on a finished one. A reader
// half-way down a finished plan keeps their place when the next turn starts.
//
// The old screen-sourced Reader never faced any of this: its single `__live__`
// sentinel absorbed every live page and every older message was a committed
// uuid that could not change. Those were properties of a sentinel that also
// painted Claude's background-agent panel as the answer (#855).
// ---------------------------------------------------------------------------

export type ReaderSelection = {
  id: string | null
  /** True when the reader is now looking at a DIFFERENT message, so the view
   *  should start it from the top. A message growing, finishing, or being
   *  handed to its committed copy is not a move: resetting the scroll there
   *  yanked the user out of the paragraph they were reading. */
  moved: boolean
}

/**
 * @param previous  the list the current selection was made against
 * @param previousId the selected message id in that list
 * @param next      the new list
 * @param following whether the reader is pinned to the growing end (the view's
 *                  stick-to-bottom state)
 *
 * Idempotent by construction: reconciling again with the result's id against
 * the same `previous` returns that id with `moved: false`. ReaderView relies on
 * that — it reconciles during render and re-renders immediately after applying
 * the result, so a second, different answer would loop the render.
 */
export function nextReaderSelection(
  previous: readonly ReaderMessage[],
  previousId: string | null,
  next: readonly ReaderMessage[],
  following: boolean,
): ReaderSelection {
  const newest = next[next.length - 1]
  if (!newest) return { id: null, moved: previousId !== null }
  if (previousId === null) return { id: newest.id, moved: true }

  const previousIds = new Set(previous.map(message => message.id))
  const nextIds = new Set(next.map(message => message.id))
  // The agent's next page is a SEMANTIC page the reader has not seen. That is
  // the whole definition, and it is deliberately narrow. Earlier rounds tried
  // "any unseen id that is not a copy of something that just left", and every
  // clause of it misfired on a real producer order:
  //   - a committed row can be listed BESIDE its live copy (OpenCode and Codex
  //     rollout publish it before completing the turn; a Claude JSONL line can
  //     beat the proxy's block_completed) — following it reset the scroll and
  //     cleared stick-to-bottom, so the reader stopped following for good;
  //   - older history loaded above the list has unseen ids too;
  //   - a next block and its predecessor's commit can arrive in one update and
  //     share a turn id, so "same source as a departed page" hid the new block.
  // A new transient provider notice is a complete status page too: a reader
  // following a stalled generation should see why it stopped. Durable notices
  // remain committed so paginating old caps never pulls the reader backwards.
  // Committed rows are never followed; the twin search below still carries a
  // reader across a live page's handoff to its committed row.
  const newPages = next.filter(message => !message.committed && !previousIds.has(message.id))
  // Among new semantic pages list order is production order (the ledger's
  // misordering, #868, only moves committed rows below the live turn).
  const newestPage = newPages[newPages.length - 1]
  const followOnto = (current: string): ReaderSelection | null => {
    if (!following || !newestPage) return null
    return newestPage.id === current
      ? { id: current, moved: false }
      : { id: newestPage.id, moved: true }
  }

  if (nextIds.has(previousId)) {
    return followOnto(previousId) ?? { id: previousId, moved: false }
  }

  // The selection left the list: a handoff, an eviction, or a trim.
  const followed = followOnto(previousId)
  if (followed) return followed

  const previousIndex = previous.findIndex(message => message.id === previousId)
  if (previousIndex < 0) return { id: newest.id, moved: true }
  const selected = previous[previousIndex]!
  const distanceFromEnd = previous.length - 1 - previousIndex

  const twin = findTwin(selected, next, distanceFromEnd)
  if (twin) return { id: twin.id, moved: false }

  // No copy of it survives (a history turn evicted by the cap, an entry trimmed
  // from the window): hold the distance from the end so the reader stays near
  // where they were rather than being thrown to the live end.
  return { id: next[Math.max(0, next.length - 1 - distanceFromEnd)]!.id, moved: true }
}

/** The message that now carries the selected page's content. Identity first:
 *  a joined committed entry shares the turn's source id but not any single
 *  page's text. Among same-source messages prefer one that contains the page's
 *  text (the per-block entry, or the joined one); only without a shared source
 *  fall back to equal normalised text (Codex rollout turn ids and committed
 *  response ids differ). Ties go to the candidate nearest the old position. */
function findTwin(
  selected: ReaderMessage,
  next: readonly ReaderMessage[],
  distanceFromEnd: number,
): ReaderMessage | null {
  // Status notices do not hand off to prose that quotes the same error. Their
  // stable ledger identity is the only proof of sameness.
  if (selected.notice) return null
  const proseNext = next.filter(message => !message.notice)
  const key = normalizeTextKey(selected.text)
  const sameSourceCandidates = proseNext.filter(message => sameSource(selected, message))
  const containing = sameSourceCandidates.filter(message => normalizeTextKey(message.text).includes(key))
  const pool = containing.length > 0
    ? containing
    : sameSourceCandidates.length > 0
      ? sameSourceCandidates
      : proseNext.filter(message => normalizeTextKey(message.text) === key)
  let best: ReaderMessage | null = null
  let bestGap = Number.POSITIVE_INFINITY
  for (const message of pool) {
    const gap = Math.abs(next.length - 1 - next.indexOf(message) - distanceFromEnd)
    if (gap < bestGap) {
      best = message
      bestGap = gap
    }
  }
  return best
}

/** Whether two lists would read identically: same messages, same order, same
 *  text and liveness. ReaderView uses it to tell a genuinely changed list from
 *  a fresh array with the same content, which must not trigger a render-phase
 *  state write (see the reconcile in ReaderView). */
export function sameReaderList(a: readonly ReaderMessage[], b: readonly ReaderMessage[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!
    const right = b[index]!
    if (left.id !== right.id || left.text !== right.text || left.live !== right.live || left.notice?.notice !== right.notice?.notice) return false
  }
  return true
}

function sameSource(a: ReaderMessage, b: ReaderMessage): boolean {
  return a.sourceId !== null && a.sourceId === b.sourceId
}
