import type { SessionRuntime } from '@renderer/session-runtime/state'

/** Which class of evidence produced the timestamp; `null` when there is none. */
export type SessionActivitySource = 'transcript' | 'runtime'

export type SessionActivity = {
  active: boolean
  timestamp: number | null
  source: SessionActivitySource | null
}

/**
 * When was this agent last active (#915)?
 *
 * ── WHY THIS IS ONE FUNCTION IN A NEUTRAL MODULE ──
 * Two surfaces answered this from the same runtime fields with different
 * rules, so they could report different times for the same agent:
 *
 *   - the TLDR peek footer took
 *     `max(lastJsonlEntryAt, phaseChangedAt, turnStartedAt, submittedAt)`,
 *     with a transcript-tail fallback that accepted any entry;
 *   - the `agent_management` inventory's `runtimeActivityAt` was
 *     `max(phaseChangedAt, turnStartedAt, submittedAt)` — no watermark — and
 *     its separate `transcriptActivityAt` was
 *     `lastJsonlEntryAt ?? latestVisibleTimestamp`, whose tail fallback
 *     accepted only `user`/`assistant` entries carrying non-empty text. The
 *     main-process bridge then recombined them as
 *     `max(transcriptLastModifiedAt ?? transcriptActivityAt, runtimeActivityAt,
 *     backendActivityAt)`, so the watermark reached the answer only when the
 *     transcript file's mtime was missing.
 *
 * (An earlier draft of this comment said the inventory left `lastJsonlEntryAt`
 * out entirely. It did not — only `runtimeActivityAt` did, and the mtime
 * usually masked the rest. Review of #1080 caught it.)
 *
 * They diverge when the newest transcript entry carries no visible text and
 * the ingest watermark is null: the footer reports that entry's time, the
 * inventory's tail fallback skips it and reports an older turn, or nothing.
 * Over 500 local Claude transcripts the newest conversation entry carries no
 * visible text in 24 of them (4.8%) — 20 `user` rows holding only a
 * `tool_result`, 4 `assistant` rows holding only a `tool_use`.
 *
 * There is no "system record" case, though an earlier draft claimed one: the
 * transcript mapper drops every system/meta record before it reaches
 * `entries`, and compact boundaries carry no timestamp at all.
 *
 * The footer's rule is the one kept, because it includes the ingest
 * watermark: `lastJsonlEntryAt` is the newest thing the transcript reader has
 * actually seen, and ignoring it means calling an agent idle while its
 * transcript is still growing.
 *
 * ── WHAT THIS IS AND IS NOT THE ANSWER TO ──
 * `agent_management` is the PROJECT-SCOPED audit surface, and its own
 * instructions require explicit user authorisation before any close; an
 * orchestrating parent reads `orchestration_list_agents`/`wait_agents`, whose
 * `lastActivityAt` comes from a different cascade in `orchestrationMcp.ts`
 * that this does not touch. So the stake here is an audit reading a
 * mid-tool-call agent as idle, not an automatic close — worth fixing, not
 * worth overstating.
 *
 * `active` is unified in NAME only: the inventory discards it and publishes
 * `activityState`, a separate rule over `processActive`/`awaitingAssistant`/
 * `streamPhase`. Only the timestamp half is genuinely shared.
 *
 * ── WHY JSONL TIME IS EVIDENCE OF TIME BUT NOT OF ACTIVITY ──
 * `active` is decided by the canonical session status alone. Phase timestamps
 * are observed work; JSONL timestamps are PRODUCER time, so replaying
 * yesterday's history would otherwise make a session look freshly active. A
 * running CLI is not activity either, nor is mounting or reloading a pane, and
 * TLDR writes never enter this signal.
 */
export function sessionActivity(runtime?: SessionRuntime): SessionActivity {
  if (!runtime) return { active: false, timestamp: null, source: null }
  const active = runtime.exited == null && runtime.sessionStatus === 'running'
  const transcriptAt = finite(runtime.lastJsonlEntryAt) ?? tailTimestamp(runtime)
  const runtimeAt = newest([runtime.phaseChangedAt, runtime.turnStartedAt, runtime.submittedAt])
  if (transcriptAt === null && runtimeAt === null) return { active, timestamp: null, source: null }
  // A tie goes to the transcript. `lastActivitySource` is cited as EVIDENCE by
  // an auditing agent, and the design doc ranks a real record above a clock a
  // repaint can move (docs/superpowers/plans/2026-07-23-open-agent-mcp-control.md).
  if (transcriptAt !== null && (runtimeAt === null || transcriptAt >= runtimeAt)) {
    return { active, timestamp: transcriptAt, source: 'transcript' }
  }
  return { active, timestamp: runtimeAt, source: 'runtime' }
}

const finite = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const newest = (values: Array<number | null | undefined>): number | null => {
  let best: number | null = null
  for (const value of values) {
    const time = finite(value)
    if (time !== null && (best === null || time > best)) best = time
  }
  return best
}

/**
 * The newest transcript entry's own timestamp, for the case where the ingest
 * watermark is null but `entries` is populated.
 *
 * WHY that state is reachable, which is not obvious: `lastJsonlEntryAt` is set
 * by the same reducers that set `entries` and only ever moves forward, so a
 * live session always has it. OLDER-HISTORY PAGING does not — `history.ts`
 * prepends mapped entries and never touches the watermark. An initial chunk
 * whose entries are all non-renderable metadata maps to zero entries and
 * leaves the watermark null; the first older page then supplies real entries
 * with it still null. That precondition is common: 351 of 500 local Claude
 * transcripts end on a `cost-state` row, and 464 of 500 tails carry no
 * timestamp at all.
 *
 * ANY entry type counts, deliberately. A tool record is the agent doing
 * something; refusing to count it is what made the inventory report an agent
 * idle while it was mid-tool-call. Chronological history lets us stop at the
 * latest valid entry instead of scanning the whole list on every render.
 */
function tailTimestamp(runtime: SessionRuntime): number | null {
  for (let index = runtime.entries.length - 1; index >= 0; index -= 1) {
    const raw = (runtime.entries[index] as { timestamp?: unknown }).timestamp
    const time = typeof raw === 'string' ? Date.parse(raw) : NaN
    if (Number.isFinite(time)) return time
  }
  return null
}
