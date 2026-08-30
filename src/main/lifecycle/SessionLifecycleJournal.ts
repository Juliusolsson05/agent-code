import type { AppRunJournalIds } from '@main/incident/journalTypes.js'
import {
  SESSION_LIFECYCLE_AREA,
  pickLifecycleData,
  severityForLifecycleEvent,
  type SessionLifecycleData,
  type SessionLifecycleEventName,
} from '@shared/lifecycle/events.js'

/**
 * The single sink for session-lifecycle events.
 *
 * WHY this is a thin wrapper over `AppRunJournal` rather than its own store:
 *
 * `AppRunJournal` already solves every hard part of always-on disk logging, and
 * each solution is scar tissue we must not re-earn — a per-run 50 MiB hard
 * ceiling (the "logging ate 500 GB" incident), a drop-oldest pending bound, an
 * atomic heartbeat, redaction through `sanitizePerformanceData`, and a silent
 * degrade to no-op when `~/.config` is unwritable so the diagnostic layer can
 * never brick launch. A second store would either duplicate all of that or,
 * far more likely, quietly omit a piece of it.
 *
 * It also matters that these events land in the SAME `events.jsonl` as heap
 * pressure, `window.unresponsive`, and crash breadcrumbs. A boot stall that
 * coincides with a GC storm is one file scan away from being obvious, and two
 * files away from never being noticed.
 *
 * WHY it takes a structural sink type instead of the concrete class: tests must
 * be able to assert emissions without constructing a real journal (which writes
 * files and installs `process.report` hooks). `AppRunJournal` satisfies this
 * type by construction, so production wiring is unchanged.
 *
 * ── THE INVARIANT THAT KEEPS THIS FROM BECOMING PART OF THE PROBLEM ──
 *
 * **Nothing in production reads these events.** This is a sink, never a
 * decider. That is the entire reason ~15 emit points scattered across the
 * lifecycle surface do not constitute new coupling: no control flow depends on
 * them, no state is derived from them, and the whole subsystem is removable in
 * one revert without touching behaviour.
 *
 * If a future fix ever needs a lifecycle fact to make a runtime decision, that
 * state belongs in `@shared` as real state with the journal as its
 * *serialization* — never a second derivation that could disagree with what the
 * code actually did. Same rule as the rendering pipeline's P4.
 */
export type LifecycleJournalSink = {
  record(input: {
    area: string
    name: string
    severity?: 'debug' | 'info' | 'warn' | 'error' | 'fatal'
    ids?: AppRunJournalIds
    data?: Record<string, unknown>
  }): void
}

export class SessionLifecycleJournal {
  /**
   * `null` is a first-class case, not a defensive afterthought: `SessionManager`
   * is constructed without a journal in tests and in any non-journaled caller,
   * and the incident journal itself degrades to `started = false` when its
   * directory is unwritable.
   */
  constructor(private readonly sink: LifecycleJournalSink | null = null) {}

  /**
   * Record one lifecycle fact.
   *
   * Contract, all three parts load-bearing:
   *
   *  1. **Never throws.** Callers sit on the recovery path — the code that
   *     repairs the app after a crash. A diagnostic that can throw turns
   *     "boot is slow" into "boot is broken", which would be a spectacular way
   *     for the observability work to become the outage. This mirrors the
   *     existing `SessionManager.recordRecovery` guard.
   *  2. **Never awaits.** Emission must not add a scheduling boundary to an
   *     ownership decision. `AppRunJournal.record` is a synchronous push onto a
   *     bounded in-memory buffer; the disk write is its own 1s timer.
   *  3. **Never widens the payload.** `pickLifecycleData` drops unallowlisted
   *     keys and non-primitive values, so a call site cannot leak content into
   *     a metadata-only stream even by accident.
   */
  record(
    name: SessionLifecycleEventName,
    ids?: AppRunJournalIds,
    data?: SessionLifecycleData,
  ): void {
    if (!this.sink) return
    try {
      this.sink.record({
        area: SESSION_LIFECYCLE_AREA,
        name,
        severity: severityForLifecycleEvent(name),
        ids,
        data: pickLifecycleData(data),
      })
    } catch {
      // Deliberately swallowed and deliberately not logged. A console.warn here
      // would fire once per event during exactly the disk-trouble that broke
      // the journal, converting a silent degradation into console spam on the
      // main thread. Lifecycle correctness outranks optional forensics.
    }
  }

  /**
   * Convenience for the overwhelmingly common shape: an event about one
   * session. Exists so call sites read as one short line — the property that
   * keeps ~15 emit points from cluttering the code they instrument.
   */
  session(
    name: SessionLifecycleEventName,
    sessionId: string,
    data?: SessionLifecycleData,
    correlationIds?: Omit<AppRunJournalIds, 'sessionId'>,
  ): void {
    // SessionManager supplies the pane id from its registry boundary; callers
    // may enrich the fact with narrower correlation identities, but can never
    // replace which pane the event belongs to.
    this.record(name, { ...correlationIds, sessionId }, data)
  }
}
