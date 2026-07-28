import { ipcMain } from 'electron'

import type { AppRunJournal } from '@main/incident/AppRunJournal.js'
import { SessionLifecycleJournal } from '@main/lifecycle/SessionLifecycleJournal.js'
import { isSessionLifecycleEventName } from '@shared/lifecycle/events.js'

// Bridges renderer-observed session-lifecycle facts into the always-on journal.
//
// WHY the renderer needs its own channel at all: main sees ownership (who holds
// the backend) but is structurally blind to intent (WHO asked for a wake, and
// whether restore ever finished). The nine wake call sites, rehydrate's
// completion accounting, transcript loading, and composer submit all live in
// the renderer. A boot ladder assembled from main alone cannot answer "why did
// something try to wake this pane", which is the question #596 and #598 both
// turned on.
//
// WHY `send` and not `invoke`: this is fire-and-forget diagnostics. An invoke
// would couple a renderer emit point to main IPC latency, and every emit point
// sits on a hot path (mount effects, submit handlers). Nothing in the renderer
// may ever wait on, or branch on, a lifecycle report.
//
// WHY main re-validates what the renderer already filtered: IPC is a runtime
// trust boundary. `ipc/incident.ts` states the rule this file follows — the
// sender "may itself be misbehaving", and a renderer mid-freeze or mid-crash is
// exactly the sender we most expect to be malformed. Filtering in the renderer
// too is not redundancy for its own sake: it means a mistake surfaces in a
// renderer unit test rather than only as a missing field on someone's disk.

export function registerLifecycleIpc(journal: AppRunJournal): void {
  const lifecycle = new SessionLifecycleJournal(journal)

  // Token bucket, same shape as the incident channel but sized for a different
  // traffic profile. Lifecycle events are routine rather than crash-adjacent,
  // and one cold boot of a large workspace legitimately emits a burst: ~15
  // visible panes × (recover.request + wake.request + history.load start/end)
  // lands ~60 events inside a second or two.
  //
  // WHY the ceiling exists anyway: a remount loop or a retry storm is precisely
  // the pathological state this instrumentation is meant to observe, and an
  // unbounded channel would let that state flood the journal and evict the
  // breadcrumbs explaining it. Dropping the excess and recording the COUNT
  // keeps the storm visible as one honest fact instead of ten thousand.
  const RATE_PER_SEC = 100
  const BURST = 300
  let tokens = BURST
  let lastRefill = Date.now()
  let suppressed = 0

  ipcMain.on('session:lifecycle-report', (_event, report: unknown) => {
    if (!report || typeof report !== 'object') return
    const r = report as Record<string, unknown>
    // An unknown name is dropped rather than passed through. The vocabulary is
    // closed on purpose (see @shared/lifecycle/events) and a renderer from a
    // different build must not be able to widen it at runtime.
    if (!isSessionLifecycleEventName(r.name)) return
    const sessionId = typeof r.sessionId === 'string' ? r.sessionId.slice(0, 200) : undefined

    const now = Date.now()
    tokens = Math.min(BURST, tokens + ((now - lastRefill) / 1000) * RATE_PER_SEC)
    lastRefill = now
    if (tokens < 1) {
      suppressed += 1
      return
    }
    tokens -= 1
    if (suppressed > 0) {
      // Recorded inline, at the point the gap happened, so a reader
      // reconstructing a ladder can tell "this pane emitted nothing" apart from
      // "this pane's events were dropped".
      lifecycle.record('report.suppressed', undefined, { suppressed, reason: 'rate-limited' })
      suppressed = 0
    }

    // `pickLifecycleData` inside the emitter drops unallowlisted keys and
    // non-primitive values, so the raw renderer payload is safe to hand over
    // untouched here — the allowlist is the boundary, not this function.
    lifecycle.record(
      r.name,
      sessionId ? { sessionId } : undefined,
      r.data as never,
    )
  })
}
