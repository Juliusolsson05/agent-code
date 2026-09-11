// Both OpenCode runtimes deliver prompts through their server's HTTP API.
// The native terminal waits for its own server to connect and re-sync; it no
// longer relies on composer readiness or PTY paste consumption (#877).
// Keep `transport` acceptance: a successful HTTP submission acknowledges the
// handoff, not a committed user message or completed turn in the transcript.
//
// WHY this ignores io.write entirely: runtime choice belongs to the concrete
// AgentSession. Its capability owns server selection and startup waiting,
// while this policy maps acceptance/failure for callers retaining a draft.

import type {
  PromptDeliveryIo,
  PromptDeliveryResult,
} from '@shared/types/providerConfig.js'

export async function deliverOpencodePrompt(
  io: PromptDeliveryIo,
): Promise<PromptDeliveryResult> {
  // Capability probe, not a cast: an opencode session that failed to
  // start (no SyncClient) — or any misconfiguration that hands us a
  // non-opencode session — lacks this method. Fail loudly instead of
  // silently no-op'ing a prompt.
  if (typeof io.session.deliverPromptText !== 'function') {
    return {
      ok: false,
      stage: 'before-write',
      code: 'missing-capability',
      message: `opencode session ${io.sessionId} has no prompt delivery capability (runtime not started?)`,
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
    if (isTerminalNotReadyError(err)) {
      return {
        ok: false,
        stage: 'before-write',
        code: 'not-ready',
        message: `opencode prompt delivery failed for session ${io.sessionId}: ${err.message}`,
        retrySafe: true,
        disposition: 'retry-same-session',
        promptWritten: false,
        enterWritten: false,
      }
    }
    return {
      ok: false,
      // Both runtimes can throw after crossing a non-transactional
      // boundary, so retrying could duplicate an already accepted prompt.
      stage: 'after-enter',
      code: 'transport-failed',
      message: `opencode prompt delivery failed for session ${io.sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      retrySafe: false,
      disposition: 'do-not-retry',
      promptWritten: true,
      enterWritten: false,
    }
  }
}

function isTerminalNotReadyError(
  error: unknown,
): error is Error & { code: 'opencode-terminal-not-ready' } {
  // Structural marker rather than importing the terminal runtime class: the
  // structured HTTP runtime also imports this delivery policy, and pulling
  // node-pty into that transport's module graph would erase the boundary the
  // two separately selectable runtimes are meant to preserve.
  return error instanceof Error &&
    'code' in error &&
    error.code === 'opencode-terminal-not-ready'
}
