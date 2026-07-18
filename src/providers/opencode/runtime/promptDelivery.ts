// Opencode prompt delivery (#406 step 5). The FIRST fully-acknowledged
// delivery protocol in the app: opencode's prompt() is an HTTP POST that
// the server accepts synchronously — no readiness gate, no bracketed-
// paste placeholder, no PTY race (contrast Codex's readiness-gate +
// atomic paste+Enter and Claude's paste → placeholder-confirm → Enter).
//
// WHY this ignores io.write entirely: io.write pushes raw bytes into a
// PTY, and opencode has none. The prompt reaches the server through the
// AgentSession.deliverPromptText capability (OpencodeSession.
// deliverPromptText → OpencodeHeadless.prompt → SyncClient HTTP). A
// throw there becomes ok:false here so the composer keeps the user's
// draft rather than clearing it on a prompt the server never received.

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
      message: `opencode session ${io.sessionId} has no HTTP prompt delivery (runtime not started?)`,
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
    return {
      ok: false,
      // Once the HTTP request was dispatched, a network exception cannot tell
      // us whether the server accepted it before the connection failed.
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
