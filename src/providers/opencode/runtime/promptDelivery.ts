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
    if (isTerminalRejectedError(err)) {
      return {
        ok: false,
        // A refusal is the one failure that proves nothing was written: the
        // server declined the request rather than forking a turn.
        stage: 'before-write',
        code: 'transport-failed',
        message: `opencode prompt delivery refused for session ${io.sessionId}: ${err.message}`,
        retrySafe: false,
        disposition: 'do-not-retry',
        promptWritten: false,
        enterWritten: false,
      }
    }
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
      // Everything else, including the package's `unknown`: the request was
      // dispatched and its outcome was never learned. OpenCode forks the
      // prompt work before it acknowledges, so retrying could duplicate a turn
      // that is already running. Report the write as possibly-performed.
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

function isTerminalRejectedError(
  error: unknown,
): error is Error & { code: 'opencode-terminal-rejected' } {
  return error instanceof Error && (error as { code?: unknown }).code === 'opencode-terminal-rejected'
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
