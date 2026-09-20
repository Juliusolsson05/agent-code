import type { SessionRuntime } from '@renderer/session-runtime/state'

/**
 * When was this agent last active, and is it active now (#915)?
 *
 * ── WHY THIS IS ONE FUNCTION IN A NEUTRAL MODULE ──
 * Two surfaces answered this question from the same runtime fields with
 * different rules, so they could report different times for the same agent:
 *
 *   - the TLDR peek footer took
 *     `max(lastJsonlEntryAt, phaseChangedAt, turnStartedAt, submittedAt)`,
 *     with a transcript-tail fallback that accepted any entry;
 *   - the `agent_management` MCP inventory left `lastJsonlEntryAt` out
 *     entirely, and its tail fallback accepted only `user`/`assistant`
 *     entries carrying non-empty text.
 *
 * They diverge exactly when the newest transcript entry is a tool or system
 * record and the ingest watermark is null: the footer reports the tool
 * record's time, the inventory skips it and reports an older turn, or nothing.
 * Cosmetic in the UI — but the inventory is what an ORCHESTRATING AGENT reads
 * to decide whether a child is idle, so two answers to "when was this last
 * active" is two answers to "is this safe to close".
 *
 * The footer's rule is the one kept, because it includes the ingest
 * watermark: `lastJsonlEntryAt` is the newest thing the transcript reader has
 * actually seen, and ignoring it means calling an agent idle while its
 * transcript is still growing.
 *
 * ── WHY JSONL TIME IS EVIDENCE OF TIME BUT NOT OF ACTIVITY ──
 * `active` is decided by the canonical session status alone. Phase timestamps
 * are observed work; JSONL timestamps are PRODUCER time, so replaying
 * yesterday's history would otherwise make a session look freshly active. A
 * running CLI is not activity either, nor is mounting or reloading a pane, and
 * TLDR writes never enter this signal.
 */
export function sessionActivity(runtime?: SessionRuntime): { active: boolean; timestamp: number | null } {
  if (!runtime) return { active: false, timestamp: null }
  const active = runtime.exited == null && runtime.sessionStatus === 'running'
  const evidence = [runtime.lastJsonlEntryAt, runtime.phaseChangedAt, runtime.turnStartedAt, runtime.submittedAt]
  if (runtime.lastJsonlEntryAt == null) {
    // Some history-loading paths predate the ingest watermark. Chronological
    // history lets us stop at the latest valid entry instead of scanning the
    // whole list on every render.
    //
    // ANY entry type counts, deliberately. A tool record is the agent doing
    // something; refusing to count it is what made the inventory report an
    // agent idle while it was mid-tool-call.
    for (let index = runtime.entries.length - 1; index >= 0; index -= 1) {
      const raw = (runtime.entries[index] as { timestamp?: unknown }).timestamp
      const time = typeof raw === 'string' ? Date.parse(raw) : NaN
      if (Number.isFinite(time)) { evidence.push(time); break }
    }
  }
  const valid = evidence.filter((time): time is number => typeof time === 'number' && Number.isFinite(time))
  return { active, timestamp: valid.length ? Math.max(...valid) : null }
}
