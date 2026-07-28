import type { SessionRuntime } from '@renderer/session-runtime/state'
import { isSessionExited } from '@renderer/workspace/providerSessionIdentity'

/**
 * Human-readable text for the readiness reasons that cross the wire.
 *
 * WHY a map and not inline strings: these are the words a user reads when the
 * composer will not accept their prompt, and the previous behaviour — a single
 * unconditional `'starting agent'` for every non-ready state — is a large part
 * of why "the agent takes minutes to start" was never actionable. A stuck pane
 * and a healthy one looked identical.
 *
 * KNOWN GAP, deliberate: the provider's detailed verdict (replay pending vs
 * composer-unpainted vs human-draft) is collapsed to 'provider-not-ready'
 * before it leaves main, so it cannot be shown here yet. Recovering it means
 * widening the SessionInputReadiness contract — Tier 3 transport this change
 * does not touch. The detail is recorded in the lifecycle journal's `gate.eval`
 * in the meantime; see docs/decomposition/agent-boot-readiness.md.
 */
const READINESS_REASON_TEXT: Record<string, string> = {
  starting: 'starting agent',
  'replaying-history': 'replaying transcript',
  'provider-not-ready': 'waiting for agent',
  ready: 'starting agent',
}

/**
 * Render an elapsed duration for a status line.
 *
 * WHY seconds and then minutes rather than a precise clock: the number exists
 * to answer one question — "is this normal, or is it wedged?" — and 3s versus
 * 4s never changes that answer, while 3s versus 4m always does.
 */
export function formatReadinessElapsed(ms: number): string {
  if (ms < 1000) return ''
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
}

/**
 * The status line under a pane whose composer is not accepting input.
 *
 * `now` is injected rather than read from the clock so the elapsed suffix is
 * testable and so the caller controls the tick rate. Passing `null` (the
 * default) omits elapsed entirely, which is what non-ticking callers want.
 */
export function resolveReadinessText(
  runtime: SessionRuntime,
  now: number | null = null,
): string | null {
  if (runtime.transcriptStatus === 'loading') {
    // #283's signature state. Elapsed matters more here than anywhere else: a
    // transcript load that never terminates is invisible without it, and used
    // to require a manual agent reload to escape.
    return withElapsed('loading transcript', runtime.inputReadinessChangedAt, now)
  }
  if (runtime.transcriptStatus === 'error') {
    return `transcript unavailable${runtime.transcriptError ? `: ${runtime.transcriptError}` : ''}`
  }
  if (runtime.transcriptStatus === 'disconnected') {
    return `transcript disconnected${runtime.transcriptError ? `: ${runtime.transcriptError}` : ''}`
  }
  if (runtime.processStatus === 'failed') {
    // WHY the typed recovery code is appended: `processError` is a stable,
    // payload-free message, but it does not say WHICH failure mode occurred.
    // 'ownership-conflict' (another backend owns this id) and 'start-failed'
    // (the provider would not launch) need completely different responses from
    // the user, and both previously rendered as 'agent failed to start'.
    const base = runtime.processError ?? 'agent failed to start'
    return runtime.recoveryFailureCode ? `${base} (${runtime.recoveryFailureCode})` : base
  }
  if (isSessionExited(runtime)) {
    return `agent exited${runtime.exited !== null ? ` (code ${runtime.exited})` : ''}`
  }

  // WHY idle is silent instead of "starting agent":
  //
  // Detached and buried sessions are deliberately rehydrated as metadata-only
  // runtimes. They wake lazily when the user sends a prompt, so `inputReady`
  // being false while `processStatus` is idle is the healthy parked state—not
  // evidence of work in progress. Showing a permanent startup warning made a
  // resource-saving implementation detail look like failed recovery. Reserve
  // the label for a backend that actually exists and is becoming ready.
  if (runtime.processStatus === 'spawning' || (runtime.processStatus === 'started' && !runtime.inputReady)) {
    const reason = runtime.inputReadinessReason
    const label = (reason && READINESS_REASON_TEXT[reason]) ?? 'starting agent'
    return withElapsed(label, runtime.inputReadinessChangedAt, now)
  }
  return null
}

function withElapsed(label: string, since: number | null, now: number | null): string {
  if (since === null || now === null) return label
  const elapsed = formatReadinessElapsed(now - since)
  return elapsed ? `${label} · ${elapsed}` : label
}
