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
import { isCodexNativeComposerEmpty } from './codexReadyForPrompt.js'

export async function deliverCodexPrompt(
  io: PromptDeliveryIo,
): Promise<PromptDeliveryResult> {
  if (typeof io.session.awaitReadyForPrompt !== 'function') {
    return {
      ok: false,
      stage: 'before-write',
      code: 'missing-capability',
      message: `Codex session ${io.sessionId} has no readiness probe (headless unavailable?)`,
      retrySafe: true,
      disposition: 'session-unusable',
      promptWritten: false,
      enterWritten: false,
    }
  }
  const ready = await io.session.awaitReadyForPrompt({
    deadlineAt: Date.now() + 15_000,
    pollIntervalMs: 50,
  })
  if (ready.kind !== 'ready') {
    return {
      ok: false,
      stage: 'before-write',
      code: 'not-ready',
      message: `Codex session ${io.sessionId} was not ready for prompt delivery (${ready.kind})`,
      retrySafe: true,
      disposition: ready.kind === 'timeout'
        ? 'retry-same-session'
        : ready.kind === 'blocked' || ready.kind === 'occupied'
          ? 'retry-after-resolve'
          : 'session-unusable',
      promptWritten: false,
      enterWritten: false,
    }
  }
  // Legacy readiness proves only that Codex accepts input: an occupied `›`
  // also passes. A generated restart task must not append to and submit that
  // draft. Keep the stricter rule provider-owned and immediately before the
  // reserved write. Plain text cannot distinguish dim placeholder content
  // from the same words typed by a human; ambiguity is a refusal, not consent.
  // #1313: the text check alone could never call Codex 0.157's empty composer
  // empty (a dim placeholder under which Codex adds a hint row), so every
  // browser-pocket restart was refused. The package's attribute-aware
  // reading says `empty` only with Codex's own empty-composer hint; either
  // proof is consent, anything else still refuses.
  const nativeEmpty = (io.session as { nativeComposerState?: () => string }).nativeComposerState?.() === 'empty'
  if (io.requireEmptyNativeComposer && !nativeEmpty && !isCodexNativeComposerEmpty(io.session.snapshotScreen?.() ?? '')) {
    return {
      ok: false, stage: 'before-write', code: 'not-ready', retrySafe: true,
      disposition: 'retry-after-resolve', promptWritten: false, enterWritten: false,
      message: 'Codex native input is occupied or cannot be verified empty. View the agent and send the restart request there; no prompt was written.',
    }
  }
  if (!io.write(`\x1b[200~${io.prompt}\x1b[201~\r`)) {
    return {
      ok: false,
      stage: 'before-write',
      code: 'write-failed',
      message: `Could not submit orchestration prompt to Codex session ${io.sessionId}`,
      retrySafe: true,
      disposition: 'session-unusable',
      promptWritten: false,
      enterWritten: false,
    }
  }
  return { ok: true, acceptance: { kind: 'transport', acceptedAt: Date.now() } }
}
