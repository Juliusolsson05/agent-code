// Codex prompt-delivery protocol (#394 phase 2c). Extracted from the
// inline `if (kind === 'codex')` branch of MCP's submitPrompt so the
// protocol lives with the provider that owns it.
//
// WHY Codex gates on readiness BEFORE the paste (unlike Claude, which
// confirms AFTER): Codex's issue #211 race is earlier in the
// lifecycle — `spawn()` has resolved and the PTY exists, but the TUI
// may still be on startup/trust chrome. Bytes written in that window
// disappear and no rollout file is created. The parent agent must not
// see `promptSubmitted: true` for that case.
//
// WHY one atomic PTY write for paste + Enter: CodexHeadless records
// submitted prompts when it sees the bracketed-paste bytes, BEFORE a
// separate Enter write would prove actual submission. The old
// orchestration path split them into two writes, which made delivery
// accounting lie in exactly the failure mode inherited orchestration
// cannot tolerate: a child resumed from the parent's transcript kept
// reading stale inherited context as if it were still the parent.
// Keeping paste+Enter atomic makes "write returned true" match the one
// operation the TUI needs to see.

import type {
  PromptDeliveryIo,
  PromptDeliveryResult,
} from '@shared/types/providerConfig.js'

export async function deliverCodexPrompt(
  io: PromptDeliveryIo,
): Promise<PromptDeliveryResult> {
  if (typeof io.session.awaitReadyForPrompt !== 'function') {
    return {
      ok: false,
      message: `Codex session ${io.sessionId} has no readiness probe (headless unavailable?)`,
    }
  }
  const ready = await io.session.awaitReadyForPrompt({
    timeoutMs: 15_000,
    pollIntervalMs: 50,
  })
  if (ready.kind !== 'ready') {
    return {
      ok: false,
      message: `Codex session ${io.sessionId} was not ready for prompt delivery (${ready.kind})`,
    }
  }
  if (!io.write(`\x1b[200~${io.prompt}\x1b[201~\r`)) {
    return {
      ok: false,
      message: `Could not submit orchestration prompt to Codex session ${io.sessionId}`,
    }
  }
  return { ok: true }
}
