// Antigravity prompt delivery: AntigravitySession.deliverPromptText hands the
// prompt to agy as an ACP session/prompt request (queued behind a running
// turn, as agy's own TUI would queue it). Acceptance is the request written
// to a live ACP connection; the turn's own events and errors arrive on the
// semantic channel.
//
// Error mapping, from the session's error codes:
//   antigravity-not-ready   nothing written (not started, stopped, or agy
//                           exited) → retry-same-session
//   anything else           the request may have reached agy → do-not-retry

import type { PromptDeliveryIo, PromptDeliveryResult } from '@shared/types/providerConfig.js'

export async function deliverAntigravityPrompt(io: PromptDeliveryIo): Promise<PromptDeliveryResult> {
  if (typeof io.session.deliverPromptText !== 'function') {
    return {
      ok: false,
      stage: 'before-write',
      code: 'missing-capability',
      message: `Antigravity session ${io.sessionId} has no structured prompt transport. Type in its native terminal, or use the rendered Agent view for automated prompts.`,
      retrySafe: true,
      disposition: 'session-unusable',
      promptWritten: false,
      enterWritten: false,
    }
  }
  try {
    const result = await io.session.deliverPromptText(io.prompt)
    // A prompt queued behind a running turn starts no turn of its own yet;
    // `queue` tells the composer not to paint it as sending (#889).
    const queued = Boolean(result && typeof result === 'object' && result.turnStarted === false)
    return { ok: true, acceptance: { kind: queued ? 'queue' : 'transport', acceptedAt: Date.now() } }
  } catch (err) {
    const code = err instanceof Error ? (err as { code?: unknown }).code : undefined
    if (code === 'antigravity-not-ready') {
      return {
        ok: false,
        stage: 'before-write',
        code: 'not-ready',
        message: `antigravity prompt delivery failed for session ${io.sessionId}: ${(err as Error).message}`,
        retrySafe: true,
        disposition: 'retry-same-session',
        promptWritten: false,
        enterWritten: false,
      }
    }
    return {
      ok: false,
      stage: 'after-enter',
      code: 'transport-failed',
      message: `antigravity prompt delivery outcome unknown for session ${io.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: true,
      enterWritten: true,
    }
  }
}
