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
function timeOf(c: RenderCandidate, slots: LiveTurnSlots): number {
  const anchor = liveTurnAnchor(c, slots)
  if (anchor !== null) return anchor.timeMs
  return c.timestampMs ?? Number.MAX_SAFE_INTEGER
}

// ---------------------------------------------------------------------------
// Amendment (#868): a committed row of the LIVE turn orders inside that turn.
//
// The law above compares a committed row's producer time with a live turn's
// start, and every block of the current turn carries that start
// (observations/semantic.ts collectTurn). That is right for rows of OTHER
// messages, and wrong for the live message's own rows: Claude Code writes one
// JSONL line per content block as the block completes, in block order, all with
// the message's id (measured on real transcripts: thinking +0.0s, text +0.84s,
// tool_use +2.27s, tool_use +4.01s). While the turn streams, its committed
// lines are therefore always EARLIER content than every block still live — yet
// each carries a time after the turn start, so it sorted below them. The
// everyday symptom is a "text, then tool call" message: once the text's line
// lands, the explanation drops below the still-streaming tool call until the
// tool_use line lands (10–30s for large tool inputs).
//
// So a committed row whose message id is the id of a selected semantic-current
// turn takes that turn's slot, and the equal-time tiebreak above (committed
// before semantic-current) puts it ahead of the turn's live blocks. Anchored
// rows tie with each other too, so `sequence` (transcript order) orders them.
//
// The same holds for TOOL RESULTS of the live turn, which carry no message id:
// Claude Code executes a tool as soon as its tool_use block completes, while
// the message is still streaming (bundle 2026-06-22 …7733b0fc: tool_use line at
// 42.238s, its tool_result 9ms later, the next tool_use at 44.141s, block 2
// still live). A committed row answering a tool_use id that belongs to the live
// turn — one of its committed tool_use lines or live tool blocks — takes the
// turn's slot as well, so the turn's committed prefix reads in transcript order
// (tool_use, result, tool_use, result) above whatever is still streaming,
// instead of the results sinking below it.
//
// WHY identity and not a better clock: per-block receipt times would still
// compare the producer clock (JSONL timestamp) with the local receipt clock
// (proxy events land 0–200ms+ late), which is a race. Message identity is the
// ledger's existing Claude handoff key (whole-turn ownership in ownership.ts).
//
// WHY the turn's slot exactly and not min(own, turn): the two times come from
// different clocks. A producer time that reads earlier than a PREVIOUS turn's
// local end would otherwise pull the row above that turn; the live turn's slot
// is, by construction, already after it.
//
// Rows of other messages, and every row when no turn is live, keep their own
// time. Ownership is untouched: this only answers "where", never "whether".
// ---------------------------------------------------------------------------
type LiveTurnSlots = {
  /** live turn id → the turn's slot (its semantic-current timestamp) */
  byTurn: ReadonlyMap<string, number>
  /** tool_use id belonging to a live turn → that turn's id */
  toolTurn: ReadonlyMap<string, string>
}

function liveTurnSlotsOf(selected: readonly RenderCandidate[]): LiveTurnSlots {
  const byTurn = new Map<string, number>()
  const toolTurn = new Map<string, string>()
  for (const c of selected) {
    if (c.owner !== 'semantic-current' || !c.turnId || c.timestampMs === null) continue
    // All blocks of one turn share the turn's start; keep the earliest in case
    // a producer ever stamps them differently.
    const existing = byTurn.get(c.turnId)
    if (existing === undefined || c.timestampMs < existing) byTurn.set(c.turnId, c.timestampMs)
    const toolId = c.toolUseId ?? c.callId
    if (toolId) toolTurn.set(toolId, c.turnId)
  }
  // A live turn also owns the tool calls it has already committed: those
  // tool_use blocks are usually suppressed as live candidates (committed tool
  // ownership), so only their committed lines still name the ids.
  for (const c of selected) {
    if (c.owner !== 'committed' || !c.messageId || !byTurn.has(c.messageId)) continue
    for (const id of c.ownedToolUseIds ?? []) toolTurn.set(id, c.messageId)
  }
  return { byTurn, toolTurn }
}

function liveTurnAnchor(
  c: RenderCandidate,
  slots: LiveTurnSlots,
): { turnId: string; timeMs: number } | null {
  if (c.owner !== 'committed') return null
  if (c.messageId) {
    const timeMs = slots.byTurn.get(c.messageId)
    if (timeMs !== undefined) return { turnId: c.messageId, timeMs }
  }
  for (const id of c.ownedToolResultIds ?? []) {
    const turnId = slots.toolTurn.get(id)
    const timeMs = turnId === undefined ? undefined : slots.byTurn.get(turnId)
    if (turnId !== undefined && timeMs !== undefined) return { turnId, timeMs }
  }
  return null
}

export function orderCandidates(
  selected: readonly RenderCandidate[],
): RenderRow[] {
  const liveTurnSlots = liveTurnSlotsOf(selected)
  const sorted = [...selected].sort((a, b) => {
    const pa = PHASE_RANK[phaseOf(a)]
    const pb = PHASE_RANK[phaseOf(b)]
    if (pa !== pb) return pa - pb
    if (phaseOf(a) === 'content') {
      const ta = timeOf(a, liveTurnSlots)
      const tb = timeOf(b, liveTurnSlots)
      if (ta !== tb) return ta - tb
      const sa = SOURCE_RANK[a.owner] ?? 3
      const sb = SOURCE_RANK[b.owner] ?? 3
      if (sa !== sb) return sa - sb
    }
    return a.sequence - b.sequence
  })
  return sorted.map((candidate, i) => {
    const anchor = liveTurnAnchor(candidate, liveTurnSlots)
    return {
      candidate,
      order: {
        sequence: i,
        timeMs: candidate.timestampMs,
        // The row explains its own placement so a debug bundle can answer
        // "why is this row here" without reconstructing the sort (plan D5) —
        // including when it sorted by its live turn's slot instead of its own
        // time.
        source: anchor !== null
          ? `${phaseOf(candidate)}:${candidate.owner}:live-turn:${anchor.turnId}@${anchor.timeMs}`
          : `${phaseOf(candidate)}:${candidate.owner}:${candidate.timestampMs ?? 'null'}`,
      },
    }
  })
}
