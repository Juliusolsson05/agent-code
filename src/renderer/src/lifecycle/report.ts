import {
  pickLifecycleData,
  type SessionLifecycleData,
  type SessionLifecycleEventName,
  type WakeCaller,
} from '@shared/lifecycle/events'

// The renderer's one entry point for session-lifecycle breadcrumbs.
//
// ── WHY THIS IS A SINGLE TWO-LINE HELPER ──
//
// Slice 3 adds ~15 emit points spread across rehydrate, nine wake call sites,
// transcript loading, and composer submit. That is exactly the shape that turns
// instrumentation into the mess it was meant to diagnose — unless every call
// site is a single statement a reader's eye skips, with no import ceremony, no
// error handling, no await, and no return value anyone consumes.
//
// The properties that keep this from being new coupling:
//   - It never throws. A diagnostic that can throw on a mount effect or a
//     submit handler would turn "boot is slow" into "boot is broken".
//   - It never awaits. No emit point may add a scheduling boundary to a
//     lifecycle decision.
//   - Nothing reads the result. Production control flow must never depend on a
//     lifecycle event; the journal is a sink, never a decider. That is what
//     makes this whole subsystem removable in one revert.
//
// If you ever want to branch on something recorded here, that is the signal
// that the fact belongs in real state (with the journal as its serialization),
// not that this helper should grow a return value.

/**
 * `window.api` is absent in unit tests, in the remote phone client bundle, and
 * for a beat during early boot before preload has attached. Resolving it lazily
 * per call — rather than capturing it at module scope — means an import of this
 * module can never itself be the thing that breaks a non-Electron surface.
 */
type LifecycleBridge = {
  reportSessionLifecycle?: (report: {
    name: SessionLifecycleEventName
    sessionId?: string
    data?: SessionLifecycleData
  }) => void
}

function bridge(): LifecycleBridge | null {
  if (typeof window === 'undefined') return null
  return (window as { api?: LifecycleBridge }).api ?? null
}

/**
 * Record one renderer-observed lifecycle fact.
 *
 * Payload is allowlist-filtered here as well as in main. Filtering twice is
 * deliberate: main cannot trust a renderer payload, and filtering renderer-side
 * means a mistaken key fails a renderer unit test instead of silently producing
 * an empty field in a file on someone's disk weeks later.
 */
export function reportLifecycle(
  name: SessionLifecycleEventName,
  sessionId?: string,
  data?: SessionLifecycleData,
): void {
  try {
    const api = bridge()
    if (!api?.reportSessionLifecycle) return
    api.reportSessionLifecycle({
      name,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(data === undefined ? {} : { data: pickLifecycleData(data) }),
    })
  } catch {
    // Swallowed without logging. A console.warn here would fire once per emit
    // point during exactly the degraded state the stream exists to capture.
  }
}

/**
 * Record that something asked for a session to be woken, and which of the nine
 * call sites asked.
 *
 * WHY `caller` is a required, closed-union argument rather than optional:
 * decomposition §3 counts nine distinct wake call sites across seven files, and
 * every historical incident (#596, #598, #590) is one of them behaving
 * differently from the others. An untagged `wake.request` is nearly worthless —
 * it says a wake happened, which we already knew. The tag is the entire
 * diagnostic value, so the type system requires it.
 */
export function reportWake(caller: WakeCaller, sessionId: string, data?: SessionLifecycleData): void {
  reportLifecycle('wake.request', sessionId, { ...data, caller })
}
