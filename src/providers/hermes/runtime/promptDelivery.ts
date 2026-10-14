// Hermes prompt delivery: the shared PromptDeliveryResult dispositions for a
// prompt sent over hermes-headless (#1482).
//
// Acceptance is `transport`, as for OpenCode: `prompt.submit` answering means
// Hermes accepted the turn (it writes the user row before replying, #111868
// upstream), not that the turn finished.
//
// The failure split matters for not running a turn twice:
//   not-ready  nothing was sent (no connection yet / reconnecting) → retry-safe
//   refused    Hermes answered with an error, so no turn started → retry-safe,
//              but do not loop on it
//   unknown    the request was written and the socket died or timed out
//              before the answer: Hermes may be running the turn right now →
//              never resend automatically

import { HermesPromptError } from 'hermes-headless'

import type { PromptDeliveryIo, PromptDeliveryResult } from '@shared/types/providerConfig.js'

export async function deliverHermesPrompt(io: PromptDeliveryIo): Promise<PromptDeliveryResult> {
  if (typeof io.session.deliverPromptText !== 'function') {
    return {
      ok: false,
      stage: 'before-write',
      code: 'missing-capability',
      message: `hermes session ${io.sessionId} has no prompt delivery capability (not started?)`,
      retrySafe: true,
      disposition: 'session-unusable',
      promptWritten: false,
      enterWritten: false,
    }
  }
  try {
    await io.session.deliverPromptText(io.prompt)
    return { ok: true, acceptance: { kind: 'transport', acceptedAt: Date.now() } }
  } catch (error) {
    const kind = error instanceof HermesPromptError ? error.kind : 'unknown'
    const message = `Hermes did not take the message: ${error instanceof Error ? error.message : String(error)}`
    if (kind === 'not-ready') {
      return { ok: false, stage: 'before-write', code: 'not-ready', message, retrySafe: true, disposition: 'retry-same-session', promptWritten: false, enterWritten: false }
    }
    if (kind === 'refused') {
      return { ok: false, stage: 'before-write', code: 'transport-failed', message, retrySafe: false, disposition: 'do-not-retry', promptWritten: false, enterWritten: false }
    }
    return { ok: false, stage: 'after-enter', code: 'transport-failed', message, retrySafe: false, disposition: 'do-not-retry', promptWritten: true, enterWritten: false }
  }
}
