import type { SubAgentState, SubAgentToolCall } from '@preload/api/types.js'

// Pure builder: turns a subagent's parsed transcript entries + its meta into a
// SubAgentState for the renderer. No I/O here so the logic is trivially
// testable and the watcher stays a thin file-tailing shell.
//
// WHY we parse JSON ourselves instead of using agent-transcript-parser: that
// package is a Claude<->Codex *converter*, not a JSONL reader. These files are
// already in Claude transcript shape, so we just JSON.parse each line and read
// the tool_use / tool_result blocks. The shapes below are intentionally
// permissive — a partial/edge entry must never throw.

/** Cap the timeline so a 300 KB+ subagent transcript can't bloat the IPC
 *  payload we push on every change. Keep the most-recent N; surface the rest
 *  as a "+N earlier" count rather than silently dropping them. */
export const SUBAGENT_TOOL_CALLS_MAX = 40

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

function headlineFromInput(
  input: Record<string, unknown> | undefined,
): string | null {
  if (!input) return null
  // Same priority ToolUseRow uses for its `⎿` sub-line, so a subagent's
  // mini-feed reads like the main feed.
  for (const k of [
    'command',
    'file_path',
    'path',
    'pattern',
    'query',
    'url',
    'description',
  ]) {
    const v = input[k]
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 80 ? v.slice(0, 80) + '…' : v
    }
  }
  return null
}

function tsToMs(ts: string | undefined): number | null {
  if (!ts) return null
  const n = Date.parse(ts)
  return Number.isFinite(n) ? n : null
}

/**
 * Build a SubAgentState from a subagent transcript's parsed entries + meta.
 *
 * @param toolUseId   parent `Agent` tool_use id (authoritative join key)
 * @param agentId     the agent-<id> filename id
 * @param meta        contents of agent-<id>.meta.json (may be partial)
 * @param entries     parsed JSONL lines of agent-<id>.jsonl
 * @param parentDone  true if the parent transcript has a tool_result for toolUseId
 * @param parentError true if that parent tool_result is an error
 */
export function buildSubAgentState(
  toolUseId: string,
  agentId: string,
  meta: SubAgentMeta,
  entries: RawEntry[],
  parentDone: boolean,
  parentError: boolean,
): SubAgentState {
  type Call = SubAgentToolCall & { id: string | null }
  const calls: Call[] = []
  const resultIds = new Set<string>()
  let turnCount = 0
  let firstTs: number | null = null
  let lastTs: number | null = null
  let lastActivity: string | null = null

  for (const e of entries) {
    const ms = tsToMs(e.timestamp)
    if (ms != null) {
      if (firstTs == null) firstTs = ms
      lastTs = ms
    }
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    if (e.type === 'assistant') turnCount += 1
    for (const b of content as RawBlock[]) {
      if (b.type === 'tool_use') {
        calls.push({
          id: typeof b.id === 'string' ? b.id : null,
          name: b.name ?? 'tool',
          headline: headlineFromInput(b.input),
          status: 'running',
        })
        lastActivity = `running ${b.name ?? 'tool'}`
      } else if (
        b.type === 'tool_result' &&
        typeof b.tool_use_id === 'string'
      ) {
        resultIds.add(b.tool_use_id)
        // The subagent's own tool call resolved — clear the activity hint so a
        // long gap before its next action doesn't read as "still running X".
        lastActivity = null
      } else if (b.type === 'thinking') {
        lastActivity = 'thinking'
      }
    }
  }

  // Resolve each call's completion precisely by id (subagent transcripts carry
  // their own tool_result blocks). Calls without an id stay 'running'.
  for (const c of calls) {
    c.status = c.id && resultIds.has(c.id) ? 'done' : 'running'
  }

  // Cap to the most recent N, recording how many we dropped off the front.
  let dropped = 0
  let kept: Call[] = calls
  if (calls.length > SUBAGENT_TOOL_CALLS_MAX) {
    dropped = calls.length - SUBAGENT_TOOL_CALLS_MAX
    kept = calls.slice(dropped)
  }
  const toolCalls: SubAgentToolCall[] = kept.map(({ name, headline, status }) => ({
    name,
    headline,
    status,
  }))

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
    startedAt: firstTs,
    lastActivityAt: lastTs,
    turnCount,
    toolCalls,
    droppedToolCalls: dropped,
    currentActivity: status === 'running' ? lastActivity : null,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// #288 ROOT-CAUSE FIX: derive-and-drop accumulator.
//
// buildSubAgentState above is a pure left-to-right fold over the whole entry
// array. SubAgentWatcher used to RETAIN that array (up to 500 RawEntry per
// agent) just so it could re-run this fold on every emit — and a dominator-tree
// heap analysis proved that retained array was ~85% of a 227 MB main-process
// heap, because each entry pins its full multi-MB tool-result/Read body.
//
// The insight (mirroring the Codex twin in codexSubagentState.ts, PR #317) is
// that NOTHING downstream needs the raw entries: emit() only ever ships the
// derived SubAgentState. So instead of retaining entries and folding at emit
// time, we fold INCREMENTALLY as each line streams in and immediately drop the
// entry. The accumulator below is the running state of that fold — a handful of
// scalars plus a small bounded ring of tool calls — so memory is O(open calls),
// not O(transcript length).
//
// `accumulateSubAgentEntry` is the per-entry step of the SAME loop body as
// buildSubAgentState; `buildSubAgentStateFromAccumulator` is the post-loop tail
// (status resolution + the parentDone/parentError gating). Keep the two paths
// equivalent in semantics — they derive the same SubAgentState and any drift is
// a silent UI regression.
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
  // Math.max — real transcripts have 21 out-of-order cases and the original
  // builder used plain assignment, so we match that exactly).
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
 * body of buildSubAgentState's loop, lifted out so the watcher can run it as
 * each line streams in and then drop the entry. The entry is read-only here; it
 * must be GC-eligible the instant this returns (the whole point of #288).
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
      if (id && !acc.resolvedToolCallIds.has(id)) acc.openToolCallIds.add(id)
      // INVARIANT 2: push then evict the OLDEST (front) past the ring cap. The
      // evicted call leaves the ring but its id STAYS in openToolCallIds if
      // still unresolved, so a later tool_result still decrements the open count.
      acc.toolCalls.push(call)
      if (acc.toolCalls.length > SUBAGENT_RING_MAX) acc.toolCalls.shift()
      // INVARIANT 4: last-write-wins activity hint.
      acc.currentActivity = `running ${b.name ?? 'tool'}`
    } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      const rid = b.tool_use_id
      acc.resolvedToolCallIds.add(rid)
      // INVARIANT 1: flip status / drop from open set independently of the ring.
      acc.openToolCallIds.delete(rid)
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
 * Produce a SubAgentState from a folded accumulator — the post-loop tail of
 * buildSubAgentState. Yields the SAME shape/values the array builder does
 * (modulo the conscious true-total counter delta documented above).
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
  // ring so the visible window matches the array builder's `kept`.
  const kept =
    acc.toolCalls.length > SUBAGENT_TOOL_CALLS_MAX
      ? acc.toolCalls.slice(acc.toolCalls.length - SUBAGENT_TOOL_CALLS_MAX)
      : acc.toolCalls
  const toolCalls: SubAgentToolCall[] = kept.map(({ name, headline, status }) => ({
    name,
    headline,
    status,
  }))

  // INVARIANT 3: dropped is derived from the TRUE total tool_use count, matching
  // the array builder's `calls.length - SUBAGENT_TOOL_CALLS_MAX` (its
  // calls.length WAS the total). max(0, …) guards the under-cap case.
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
    // INVARIANT 6: gate currentActivity on the build-time status, just like the
    // array builder (only a running agent shows a live activity label).
    currentActivity: status === 'running' ? acc.currentActivity : null,
  }
}
