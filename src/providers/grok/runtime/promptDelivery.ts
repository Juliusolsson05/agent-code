// Grok prompt delivery policy: maps GrokSession.deliverPromptText outcomes onto
// the shared PromptDeliveryResult dispositions callers already understand from
// OpenCode Terminal's policy.
//
// WHY this ignores io.write entirely: delivery belongs to the concrete
// AgentSession. Grok prompts go over the owned control connection with a client
// prompt id, because acceptance is only correlated there (catalog
// prompt.acceptance) and a PTY paste can attach clipboard images the composer
// never saw.

import type { PromptDeliveryIo, PromptDeliveryResult } from '@shared/types/providerConfig.js'

export async function deliverGrokPrompt(io: PromptDeliveryIo): Promise<PromptDeliveryResult> {
  // Capability probe, not a cast: a grok session that failed to start — or any
  // misconfiguration that hands us a non-grok session — lacks this method. Fail
  // loudly instead of silently no-op'ing a prompt.
  if (typeof io.session.deliverPromptText !== 'function') {
    return {
      ok: false,
      stage: 'before-write',
      code: 'missing-capability',
      message: `grok session ${io.sessionId} has no prompt delivery capability (runtime not started?)`,
      retrySafe: true,
      disposition: 'session-unusable',
      promptWritten: false,
      enterWritten: false,
    }
  }
  try {
    await io.session.deliverPromptText(io.prompt)
    // Transport acceptance, not a committed user message or completed turn:
    // native has admitted the prompt to its queue (prompt.acceptance); the
    // durable user row and the turn arrive through the transcript channels.
    return { ok: true, acceptance: { kind: 'transport', acceptedAt: Date.now() } }
  } catch (err) {
    if (isGrokRejectedError(err)) {
      return {
        ok: false,
        // The one outcome that proves nothing ran: native answered the request
        // with an error before accepting it (control.rpc-failure).
        stage: 'before-write',
        code: 'transport-failed',
        message: `grok prompt delivery refused for session ${io.sessionId}: ${err.message}`,
        retrySafe: false,
        disposition: 'do-not-retry',
        promptWritten: false,
        enterWritten: false,
      }
    }
    if (isGrokNotReadyError(err)) {
      return {
        ok: false,
        stage: 'before-write',
        code: 'not-ready',
        message: `grok prompt delivery failed for session ${io.sessionId}: ${err.message}`,
        retrySafe: true,
        disposition: 'retry-same-session',
        promptWritten: false,
        enterWritten: false,
      }
    }
    return {
      ok: false,
      // Everything else is `uncertain` or `unconfirmed`: the request was
      // written and native may already be running the turn, so retrying could
      // duplicate work (decision uncertain-prompts — never resend). Report the
      // write as possibly-performed; the turn itself, if native runs it, still
      // flows through the normal channels.
      stage: 'after-enter',
      code: 'transport-failed',
      message: `grok prompt delivery failed for session ${io.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: true,
      enterWritten: false,
    }
  }
}

// Structural markers rather than importing the runtime class: this policy is
// imported by registry surfaces that must not pull node-pty into their graph,
// the same boundary OpenCode's policy keeps between its two runtimes.
function isGrokRejectedError(error: unknown): error is Error & { code: 'grok-terminal-rejected' } {
  return error instanceof Error && (error as { code?: unknown }).code === 'grok-terminal-rejected'
}

function isGrokNotReadyError(error: unknown): error is Error & { code: 'grok-terminal-not-ready' } {
  return error instanceof Error && (error as { code?: unknown }).code === 'grok-terminal-not-ready'
}
