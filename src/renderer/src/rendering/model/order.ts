import type { RenderCandidate, RenderRow } from '@renderer/rendering/model/types'

// ---------------------------------------------------------------------------
// The ordering law (plan D4, #172 comments 5/6, feed-render-item-plan).
//
// This is a TRUE CHRONOLOGICAL MERGE, not plane concatenation. The bug this
// kills: the legacy renderer painted `entries → semantic history → semantic
// current → work` as fixed JSX planes, so a stale semantic-history row could
// sit visually BELOW a newer user prompt — the prompt existed but was not
// the visual tail ("STILL NOT SHOWING FUCKING USER PROMPT" bundle, #239).
//
// The law: a semantic-history unit whose turn ENDED before a user entry's
// timestamp sorts BEFORE that entry; live semantic that STARTED after the
// prompt sorts after it. Candidates carry those times in timestampMs per
// the trust hierarchy (committed entry.timestamp > semantic startedAt/
// endedAt > null). Ordering NEVER decides visibility — ownership already
// did (plan D3: ownership before ordering). Every candidate reaching this
// module will be painted; this module only answers "in what order".
// ---------------------------------------------------------------------------

// Phase ranks: empty paints only when nothing else exists; work always
// paints last. `empty + work` is a legal combination (work is a lifecycle
// fact, not text — plan §7 rule 8).
const PHASE_RANK: Record<string, number> = { empty: 0, content: 1, work: 2 }

function phaseOf(c: RenderCandidate): 'empty' | 'content' | 'work' {
  if (c.owner === 'empty') return 'empty'
  if (c.owner === 'work') return 'work'
  return 'content'
}

// Tiebreak source ranks at EQUAL timestamps (feed-render-item-plan's
// five-way tiebreak, carried verbatim): committed entry before semantic
// history, semantic history before semantic current, everything else after.
// WHY entry-first at a tie: the committed row is the durable form; when a
// bridge row and its durable twin somehow share a timestamp, the durable
// one reads as "the transcript" and the bridge as "the echo".
const SOURCE_RANK: Record<string, number> = {
  committed: 0,
  'optimistic-submit': 0, // stands in for its future committed row
  'semantic-history': 1,
  'ghost-fallback': 1, // recovery rows order like the history they replace
  'semantic-current': 2,
}

/**
 * Null timestamps sort AFTER timestamped content: a missing timestamp is
 * lossy evidence, not proof the row happened last — but we cannot invent a
 * position for it, so it goes to the tail of its phase, stabilized by
 * sequence. (Dump: "Null timestamps sort after timestamped content, not as
 * 'now'.")
 */
function timeOf(c: RenderCandidate): number {
  return c.timestampMs ?? Number.MAX_SAFE_INTEGER
}

export function orderCandidates(
  selected: readonly RenderCandidate[],
): RenderRow[] {
  const sorted = [...selected].sort((a, b) => {
    const pa = PHASE_RANK[phaseOf(a)]
    const pb = PHASE_RANK[phaseOf(b)]
    if (pa !== pb) return pa - pb
    if (phaseOf(a) === 'content') {
      const ta = timeOf(a)
      const tb = timeOf(b)
      if (ta !== tb) return ta - tb
      const sa = SOURCE_RANK[a.owner] ?? 3
      const sb = SOURCE_RANK[b.owner] ?? 3
      if (sa !== sb) return sa - sb
    }
    return a.sequence - b.sequence
  })
  return sorted.map((candidate, i) => ({
    candidate,
    order: {
      sequence: i,
      timeMs: candidate.timestampMs,
      // The row explains its own placement so a debug bundle can answer
      // "why is this row here" without reconstructing the sort (plan D5).
      source: `${phaseOf(candidate)}:${candidate.owner}:${candidate.timestampMs ?? 'null'}`,
    },
  }))
}
