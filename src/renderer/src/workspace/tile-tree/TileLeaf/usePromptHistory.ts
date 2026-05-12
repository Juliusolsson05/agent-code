import { useMemo, useState } from 'react'

import { extractLatestUserPrompts } from '@renderer/features/workspace/lib/latestUserPrompts'
import type { Entry } from '@shared/types/transcript'
import type { SessionKind } from '@renderer/workspace/types'

// ---- Prompt history state ----
//
// Agent Code keeps its own bash-style history for the composer
// instead of forwarding Up/Down to CC. Two reasons:
//   1. CC's own history updates CC's own input box in the terminal
//      buffer, but our composer is a React textarea — the two
//      states never reconcile, so pressing Up in our composer and
//      letting CC handle it produced no visible change for the
//      user. The whole thing looked broken.
//   2. We already have every past user prompt in runtime.entries,
//      pulled from the JSONL transcript. Deriving a history list
//      from that is nearly free.
//
// `historyIndex` is null when the user is NOT cycling (fresh
// draft, or just typed something), and a number in
// [0, history.length - 1] while cycling. 0 = most recent historic
// prompt, 1 = one before that, etc. When cycling is active the
// composer displays the history[historyIndex] string, not the
// live draft.
//
// `historyAnchor` stores whatever was in the composer the moment
// the user first pressed Up to enter the cycle. Pressing Down past
// the newest historic prompt (i.e. historyIndex back to -1)
// restores this string so the user doesn't lose mid-typed work.
//
// Both pieces of state are component-local (not runtime). They
// don't need to survive tab-switch because the moment the user
// comes back to the tab, they start fresh — cycling mid-tab-
// switch isn't a real workflow. Keeping them local avoids
// cluttering SessionRuntime and avoids the re-render cost of
// threading through the store.
//
// ---- History derivation ----
//
// Filter: the user-role slot in CC's JSONL is used for MANY things
// besides real typed prompts. Without proper filtering our history
// picks up strings the user never actually typed, which feels
// exactly like "another prompt got injected into my input" — the
// exact bug that forced us to revert the first cut of this
// feature.
//
// Concrete noise we've seen in real transcripts:
//
//   1. `isMeta: true` entries like "Continue from where you left
//      off." — CC's auto-continue hint. User never typed it.
//   2. `<local-command-caveat>…` and `<command-name>/clear…` —
//      system markers for local-command invocations.
//   3. "Unknown skill: resumeOne" and similar — CC's error
//      response to bad slash-command invocations. Logged as a
//      user-role entry, plain-text content, doesn't start with
//      '<'. THE main offender that made it into the first cut.
//   4. Tool-result-only user-role entries — no text blocks at
//      all, just the results for the previous assistant turn's
//      tool_use blocks.
//
// Positive signal for "this was a real prompt the user typed":
// the entry has a `permissionMode` field set. Empirically every
// real user prompt in the current transcript carries it; every
// synthetic entry (isMeta, error responses, local-command
// markers) lacks it. The filter applied here lives in
// `extractLatestUserPrompts`; this hook just consumes its output.
//
// Dedup: adjacent identical prompts (the "oops, meant to add
// detail" resubmit pattern) collapse into one entry. Distant
// duplicates stay, matching bash history behavior. Memoed on
// entries reference so normal re-renders don't rebuild the list.
export type PromptHistory = {
  /** Most-recent-first list of historic user prompts. */
  history: string[]
  /** null when not cycling; index into `history` when cycling. */
  historyIndex: number | null
  /** Composer text captured on cycle entry; restored on Down
   *  past the newest entry. */
  historyAnchor: string
  /** True while a cycle is in progress. */
  cyclingHistory: boolean
  setHistoryIndex: (index: number | null) => void
  setHistoryAnchor: (text: string) => void
  /** Cancel the cycle without changing composer text. Called when
   *  any non-Up/Down edit (typing, paste, delete, submit) fires. */
  endHistoryCycle: () => void
}

export function usePromptHistory({
  entries,
  sessionKind,
}: {
  entries: Entry[]
  sessionKind: SessionKind | undefined
}): PromptHistory {
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [historyAnchor, setHistoryAnchor] = useState<string>('')

  const history = useMemo(() => {
    return extractLatestUserPrompts(entries, sessionKind).map(prompt => prompt.text)
  }, [entries, sessionKind])

  const cyclingHistory = historyIndex !== null
  const endHistoryCycle = () => {
    if (historyIndex !== null) setHistoryIndex(null)
  }

  return {
    history,
    historyIndex,
    historyAnchor,
    cyclingHistory,
    setHistoryIndex,
    setHistoryAnchor,
    endHistoryCycle,
  }
}
