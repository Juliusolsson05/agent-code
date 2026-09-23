// Pi prompt delivery: through the bridge extension, never by pasting into
// the TUI (a paste into a TUI that is not ready is silently lost — #877).
//
// The package answers with Pi's own evidence (pi-terminal-headless
// PiTerminalHeadless.submitPrompt): 'started' / 'queued' is transport
// acceptance; `no-live-channel` and `rejected` prove nothing reached pi;
// `unknown` means pi may still run it, so it must never be retried
// automatically. PiSession.deliverPromptText maps those onto the error codes
// below, exactly as OpenCode Terminal does.

import type { PromptDeliveryIo, PromptDeliveryResult } from '@shared/types/providerConfig.js'

export async function deliverPiPrompt(io: PromptDeliveryIo): Promise<PromptDeliveryResult> {
  if (typeof io.session.deliverPromptText !== 'function') {
    return {
      ok: false,
      stage: 'before-write',
      code: 'missing-capability',
      message: `pi session ${io.sessionId} has no prompt delivery capability (runtime not started?)`,
      retrySafe: true,
      disposition: 'session-unusable',
      promptWritten: false,
      enterWritten: false,
    }
  }
  try {
    await io.session.deliverPromptText(io.prompt)
    return { ok: true, acceptance: { kind: 'transport', acceptedAt: Date.now() } }
  } catch (err) {
    const code = err instanceof Error ? (err as { code?: unknown }).code : undefined
    if (code === 'pi-terminal-not-ready') {
      return {
        ok: false,
        stage: 'before-write',
        code: 'not-ready',
        message: `pi prompt delivery failed for session ${io.sessionId}: ${(err as Error).message}`,
        retrySafe: true,
        disposition: 'retry-same-session',
        promptWritten: false,
        enterWritten: false,
      }
    }
    if (code === 'pi-terminal-rejected') {
      return {
        ok: false,
        stage: 'before-write',
        code: 'transport-failed',
        message: `pi refused the prompt for session ${io.sessionId}: ${(err as Error).message}`,
        retrySafe: false,
        disposition: 'do-not-retry',
        promptWritten: false,
        enterWritten: false,
      }
    }
    // `unknown`: the request reached pi and no evidence came back. Report it
    // as possibly written so no caller resubmits the user's work.
    return {
      ok: false,
      stage: 'after-enter',
      code: 'transport-failed',
      message: `pi prompt delivery outcome unknown for session ${io.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: true,
      enterWritten: false,
    }
  }
}
