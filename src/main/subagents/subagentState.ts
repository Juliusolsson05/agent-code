import type { SubAgentState, SubAgentToolCall } from '@preload/api/types.js'
import {
  headlineFromInput,
  SUBAGENT_TOOL_CALLS_MAX,
  tsToMs,
} from './shared.js'

export { SUBAGENT_TOOL_CALLS_MAX } from './shared.js'

// Pure derivation helpers for Claude subagent transcript entries. No I/O here
// so the watcher stays a thin file-tailing shell and the lifecycle boundary is
// clear: SubAgentWatcher owns files/timers/offsets; this module owns the small
// retained accumulator that is safe to keep in memory.
//
// WHY we parse JSON ourselves instead of using agent-transcript-parser: that
// package is a Claude<->Codex *converter*, not a JSONL reader. These files are
// already in Claude transcript shape, so we just JSON.parse each line and read
// the tool_use / tool_result blocks. The shapes below are intentionally
// permissive — a partial/edge entry must never throw.

type RawBlock = {
  type?: string
  name?: string
  id?: string
  tool_use_id?: string
  is_error?: boolean
  input?: Record<string, unknown>
}
type RawEntry = {
  type?: string
  timestamp?: string
  message?: { role?: string; content?: unknown }
}

export type SubAgentMeta = {
  agentType?: string
  description?: string
  toolUseId?: string
}

// ────────────────────────────────────────────────────────────────────────────
// #288 ROOT-CAUSE FIX: derive-and-drop accumulator.
//
// SubAgentWatcher used to RETAIN a RawEntry[] per agent (capped later at 500
// entries) and re-fold that array on every emit. A dominator-tree heap analysis
// proved the retained arrays were ~85% of a 227 MB main-process heap, because
// each entry pins its full multi-MB tool-result/Read body.
//
// The insight (mirroring the Codex twin in codexSubagentState.ts, PR #317) is
// that NOTHING downstream needs the raw entries: emit() only ever ships the
// derived SubAgentState. So instead of retaining entries and folding at emit
// time, we fold INCREMENTALLY as each line streams in and immediately drop the
// entry. The accumulator below is the running state of that fold — a handful of
// scalars plus a small bounded ring of tool calls — so memory is O(open calls),
// not O(transcript length).
//
// `accumulateSubAgentEntry` is now the source of truth for per-entry derivation;
// `buildSubAgentStateFromAccumulator` is the only projection path to
// SubAgentState. The old array builder was intentionally deleted in the second
// audit pass because keeping a dead "parity oracle" beside the live fold made
// the comments drift-prone: future changes could update one path and leave the
// other lying. If you need to validate parity with a historical entry-array
// fold, do it in a focused test fixture, not by reviving runtime dead code.
//
// CONSCIOUS BEHAVIOR DELTA (see SubAgentWatcher.ts wiring + the PR): the old
// watcher capped retained entries at 500 and folded only that 500-entry TAIL, so
// `turnCount` and `droppedToolCalls` were relative-to-the-last-500. This
// accumulator folds EVERY entry from the start, so those counters are now TRUE
// running totals — strictly higher for very long agents (6/318 measured
// transcripts exceed 60 tool calls; max 79). That is MORE correct, not a
// regression: the displayed timeline is still capped to SUBAGENT_TOOL_CALLS_MAX,
// only the "+N earlier" count grows to the real total.

/**
 * Ring capacity for retained tool-call display objects.
 *
 * INVARIANT 2: measured max simultaneously-open tool calls (a tool_use with no
 * yet-seen tool_result) across 318 real transcripts = 8. The ring must be ≥ that
 * worst-case tool_use→tool_result gap or a tool_result could arrive after its
 * tool_use's display object was already evicted, and the status flip would be
 * lost FROM THE RING. 60 is 7× headroom over the observed 8 — generous enough
 * that this can never bite, small enough that the per-agent footprint stays
 * trivially bounded.
 *
 * NOTE: status resolution itself does NOT depend on the call still being in the
 * ring — openToolCallIds (invariant 1) tracks unresolved ids independently, so a
 * flip is never *miscounted* even past the ring. The ring cap only bounds how
 * many call objects we can DISPLAY; it is sized so the most-recent
 * SUBAGENT_TOOL_CALLS_MAX (40) shown calls are always present.
 */
const SUBAGENT_RING_MAX = 60

type ToolCallAcc = SubAgentToolCall & { id: string | null }

export type SubAgentAccumulator = {
  // INVARIANT 5: startedAt is the FIRST valid timestamp seen (set once);
  // lastActivityAt is the LAST valid timestamp seen (last-write-wins, NOT
  // Math.max — real transcripts have 21 out-of-order cases, and the pre-#288
  // retained-entry fold used plain assignment, so we preserve that behavior).
  startedAt: number | null
  lastActivityAt: number | null
  // INVARIANT 3: monotonic fold counters, incremented as entries stream, NEVER
  // derived from ring contents. turnCount ++ per assistant entry. totalToolUses
  // is the true count of every tool_use ever seen; droppedToolCalls is derived
  // from it at build time as max(0, total - SUBAGENT_TOOL_CALLS_MAX).
  turnCount: number
  totalToolUses: number
  // INVARIANT 4: literal last-write-wins per block in arrival order. Set to
  // `running <tool>` on tool_use, CLEARED to null on tool_result, set to
  // `thinking` on a thinking block. Not reinterpreted as "last open call".
  currentActivity: string | null
  // Bounded ring of the most-recent tool-call display objects (invariant 2).
  toolCalls: ToolCallAcc[]
  // INVARIANT 1: STANDALONE set of unresolved tool_use ids, persisted
  // independently of the ring. A tool_result flips its call to done / decrements
  // the open count by removing its id here EVEN IF the call object was already
  // evicted from the ring. Status resolution must never depend on ring presence.
  openToolCallIds: Set<string>
  // Ids that have seen a tool_result. Kept so an out-of-order or
  // arrived-after-eviction tool_result still marks a still-present ring call as
  // done (the original builder resolved status by a result-id set, so we do too).
  resolvedToolCallIds: Set<string>
}

export function createAccumulator(): SubAgentAccumulator {
  return {
    startedAt: null,
    lastActivityAt: null,
    turnCount: 0,
    totalToolUses: 0,
    currentActivity: null,
    toolCalls: [],
    openToolCallIds: new Set(),
    resolvedToolCallIds: new Set(),
  }
}

/**
 * Fold one parsed transcript entry into the accumulator. This is the per-entry
 * derivation step the watcher runs as each line streams in before dropping the
 * entry. The entry is read-only here; it must be GC-eligible the instant this
 * returns (the whole point of #288).
 */
export function accumulateSubAgentEntry(
  acc: SubAgentAccumulator,
  entry: RawEntry,
): void {
  const ms = tsToMs(entry.timestamp)
  if (ms != null) {
    // INVARIANT 5: first-seen sets startedAt once; every valid ts overwrites
    // lastActivityAt (last-write-wins, matching the old `lastTs = ms`).
    if (acc.startedAt == null) acc.startedAt = ms
    acc.lastActivityAt = ms
  }
  const content = entry.message?.content
  if (!Array.isArray(content)) return
  // INVARIANT 3: per-assistant-entry turn counter, monotonic.
  if (entry.type === 'assistant') acc.turnCount += 1
  for (const b of content as RawBlock[]) {
    if (b.type === 'tool_use') {
      // INVARIANT 3: true total of every tool_use, never the ring length.
      acc.totalToolUses += 1
      const id = typeof b.id === 'string' ? b.id : null
      const call: ToolCallAcc = {
        id,
        name: b.name ?? 'tool',
        headline: headlineFromInput(b.input),
        // Tentative — resolved at build time against resolvedToolCallIds. If a
        // tool_result for this id already streamed past (out-of-order), reflect
        // it immediately so a same-build read is consistent.
        status: id && acc.resolvedToolCallIds.has(id) ? 'done' : 'running',
      }
      // INVARIANT 1: track unresolved ids independently of the ring. Only ids
      // not already resolved are "open"; a tool_use whose result already
      // arrived is not open.
      if (id) {
        if (acc.resolvedToolCallIds.has(id)) {
          // BOUND resolvedToolCallIds (consume side): this id's tool_result
          // arrived BEFORE its tool_use (result-before-use — the ONLY reason this
          // set exists). The pending result has now been consumed (the `status`
          // field above is already resolved to 'done'), so this id is provably
          // never needed again: ids are unique per call, so a consumed id can't be
          // re-resolved. Deleting it bounds the set to the tiny out-of-order
          // window instead of letting it grow O(total calls) for the agent's whole
          // lifetime. This does NOT change the resolved outcome — the status flip
          // already happened at push time; we only free memory.
          acc.resolvedToolCallIds.delete(id)
        } else {
          acc.openToolCallIds.add(id)
        }
      }
      // INVARIANT 2: push then evict the OLDEST (front) past the ring cap. The
      // evicted call leaves the ring but its id STAYS in openToolCallIds if
      // still unresolved, so a later tool_result still decrements the open count.
      acc.toolCalls.push(call)
      if (acc.toolCalls.length > SUBAGENT_RING_MAX) acc.toolCalls.shift()
      // INVARIANT 4: last-write-wins activity hint.
      acc.currentActivity = `running ${b.name ?? 'tool'}`
    } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      const rid = b.tool_use_id
      // INVARIANT 1: flip status / drop from open set independently of the ring.
      // `delete` returns true iff rid was open, i.e. iff its tool_use was ALREADY
      // seen (in-order — the dominant case). When that's true the ring flip below
      // fully resolves the call and rid is never consumed again (ids are unique),
      // so it must NOT be recorded in resolvedToolCallIds: doing so would leak one
      // entry per resolved call for the agent's whole lifetime — the very
      // unboundedness this fix removes. We stash rid ONLY for the result-before-use
      // case (tool_use not yet seen → delete returns false), so a later tool_use
      // can find it, mark itself done, and prune it (consume side above). Net:
      // resolvedToolCallIds holds only the still-pending out-of-order window
      // (observed max 8), not O(total calls). Outcome is unchanged — the in-order
      // ring flip below is identical; only the no-longer-needed stash is dropped.
      const wasOpen = acc.openToolCallIds.delete(rid)
      if (!wasOpen) acc.resolvedToolCallIds.add(rid)
      for (const c of acc.toolCalls) {
        if (c.id === rid) c.status = 'done'
      }
      // INVARIANT 4: a resolved call clears the activity hint so a long gap
      // before the next action doesn't read as "still running X".
      acc.currentActivity = null
    } else if (b.type === 'thinking') {
      // INVARIANT 4.
      acc.currentActivity = 'thinking'
    }
  }
}

/**
 * Produce a SubAgentState from a folded accumulator. This is the only live
 * projection from watcher state to renderer state; keeping this boundary narrow
 * is what lets the watcher drop raw transcript entries immediately.
 *
 * INVARIANT 6: terminal done/error and the status/currentActivity gating are
 * computed HERE at build time from parentDone/parentError (which come from
 * parentResult), NOT stored in the accumulator — so a late parentResult flip
 * re-renders correctly the next time emit() builds from the live accumulator.
 */
export function buildSubAgentStateFromAccumulator(
  acc: SubAgentAccumulator,
  toolUseId: string,
  agentId: string,
  meta: SubAgentMeta,
  parentDone: boolean,
  parentError: boolean,
): SubAgentState {
  // The ring already holds at most SUBAGENT_RING_MAX (60) most-recent calls; the
  // renderer shows at most SUBAGENT_TOOL_CALLS_MAX (40). Slice the tail of the
  // ring so the visible window is always the most recent displayable calls.
  const kept =
    acc.toolCalls.length > SUBAGENT_TOOL_CALLS_MAX
      ? acc.toolCalls.slice(acc.toolCalls.length - SUBAGENT_TOOL_CALLS_MAX)
      : acc.toolCalls
  const toolCalls: SubAgentToolCall[] = kept.map(({ name, headline, status }) => ({
    name,
    headline,
    status,
  }))

  // INVARIANT 3: dropped is derived from the TRUE total tool_use count, not the
  // bounded display ring. max(0, …) guards the under-cap case.
  const droppedToolCalls = Math.max(0, acc.totalToolUses - SUBAGENT_TOOL_CALLS_MAX)

  const status: SubAgentState['status'] = parentError
    ? 'error'
    : parentDone
      ? 'done'
      : 'running'

  return {
    toolUseId,
    agentId,
    agentType: meta.agentType ?? 'agent',
    description: meta.description ?? '',
    status,
    startedAt: acc.startedAt,
    lastActivityAt: acc.lastActivityAt,
    turnCount: acc.turnCount,
    toolCalls,
    droppedToolCalls,
    // INVARIANT 6: gate currentActivity on the build-time status so only a
    // running agent shows a live activity label.
    currentActivity: status === 'running' ? acc.currentActivity : null,
  }
}
