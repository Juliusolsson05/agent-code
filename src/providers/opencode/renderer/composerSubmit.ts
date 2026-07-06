// OpenCode composer submit (#406 step 5 target; loud stub at step 2).
//
// Opencode has no PTY, so this protocol must NOT use io.send (raw PTY
// bytes) — the real implementation routes through the new
// `session:deliver-prompt` IPC onto SessionManager.deliverPromptToAgent
// → registry deliverPrompt → HTTP prompt(). Throwing here (rather than
// silently succeeding) preserves the composer's draft: the call site's
// catch path keeps the user's text on failure.

import type { ComposerSubmitIo } from '@providers/registry.renderer.capabilities'

export async function opencodeComposerSubmit(io: ComposerSubmitIo): Promise<void> {
  throw new Error(
    `opencode composer submit is not wired yet (#406) — session ${io.sessionId}`,
  )
}
