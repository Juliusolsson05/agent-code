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
    if (code === 'pi-terminal-tui-command') {
      // One of pi's own TUI commands (`/new`, `/tree`, ...). Nothing reached
      // pi, so a retry is harmless (retrySafe), but it can never succeed:
      // do-not-retry, so an orchestration parent is not told to try again
      // (PR review of pi-terminal-headless#2). `missing-capability` is the
      // honest code: this delivery path cannot run TUI commands; the message
      // tells the user to type it in the pane.
      return {
        ok: false,
        stage: 'before-write',
        code: 'missing-capability',
        message: `pi refused the prompt for session ${io.sessionId}: ${(err as Error).message}`,
        retrySafe: true,
        disposition: 'do-not-retry',
        promptWritten: false,
        enterWritten: false,
      }
    }
    if (code === 'pi-terminal-rejected') {
      // Safe to retry, unlike OpenCode's refusal. Every Pi refusal is a check
      // the bridge makes BEFORE handing the text to pi: a compaction is
      // running, no model is selected, the runtime is being replaced
      // mid-switch, or pi exposes no compaction API. The text provably never
      // reached pi. Reporting do-not-retry made an orchestration parent drop
      // a brief that only had to wait for a compaction to finish.
      return {
        ok: false,
        stage: 'before-write',
        code: 'transport-failed',
        message: `pi refused the prompt for session ${io.sessionId}: ${(err as Error).message}`,
        retrySafe: true,
        disposition: 'retry-same-session',
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
