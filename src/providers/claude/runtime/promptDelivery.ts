// Claude prompt-delivery protocol (#394 phase 2c). Extracted from the
// inline `if (kind === 'claude')` branch of MCP's submitPrompt so the
// protocol lives with the provider that owns it.
//
// WHY bracketed paste instead of plain keystrokes: orchestration
// prompts are long, markdown-heavy bootstrap prompts. Raw keystrokes
// would let the TUI interpret newlines/escapes as interactive input.
// Bracketed paste is the same terminal-level contract the composer
// uses for large prompts.
//
// WHY Claude waits AFTER the paste (unlike Codex, which gates BEFORE):
// Claude's known race is paste-commit ordering — the composer is
// present, but Enter can arrive before the paste accumulator has
// replaced the payload with `[Pasted text #N]`. Waiting for the
// placeholder proves the paste committed; only then is Enter safe.
// The delivery boundary the caller relies on: `ok: true` means the
// prompt was pasted, confirmed, and submitted.

import type {
  PromptDeliveryIo,
  PromptDeliveryResult,
} from '@shared/types/providerConfig.js'

// Same routing predicate as the desktop composer (composerSubmit.ts /
// claudePaste.ts CLAUDE_PASTE_THRESHOLD — keep the two values in lockstep;
// duplicated because this runtime module cannot import renderer code).
// WHY it exists here: Claude's TUI only renders the `[Pasted text #N]`
// placeholder for pastes big enough to collapse — a short single-line
// paste inlines as plain text and NO placeholder ever appears. The
// original consumer (orchestration) only sends long markdown bootstraps,
// so the always-paste + hard-placeholder protocol below never failed —
// until the remote companion routed arbitrary phone prompts through this
// module and every short prompt timed out unconfirmed ("did not confirm
// pasted prompt before submit"). Short prompts take the composer's plain
// route instead: text + Enter in ONE write, which cannot race the paste
// accumulator because there is no paste.
const CLAUDE_PASTE_THRESHOLD = 100

function isPasteLike(prompt: string): boolean {
  return prompt.includes('\n') || prompt.length > CLAUDE_PASTE_THRESHOLD
}

export async function deliverClaudePrompt(
  io: PromptDeliveryIo,
): Promise<PromptDeliveryResult> {
  if (!isPasteLike(io.prompt)) {
    if (!io.write(`${io.prompt}\r`)) {
      return {
        ok: false,
        message: `Could not write prompt to session ${io.sessionId}`,
      }
    }
    return { ok: true }
  }

  if (!io.write(`\x1b[200~${io.prompt}\x1b[201~`)) {
    return {
      ok: false,
      message: `Could not write orchestration prompt to session ${io.sessionId}`,
    }
  }

  // awaitPastePlaceholder is a typed optional on AgentSession — a
  // Claude runtime build that loses it degrades to a visible delivery
  // failure here, not a TypeError.
  if (typeof io.session.awaitPastePlaceholder !== 'function') {
    return {
      ok: false,
      message: `Claude session ${io.sessionId} has no paste-placeholder probe (headless unavailable?)`,
    }
  }
  const placeholder = await io.session.awaitPastePlaceholder({
    timeoutMs: 2000,
    pollIntervalMs: 50,
  })
  if (placeholder.kind !== 'appeared') {
    return {
      ok: false,
      message: `Claude session ${io.sessionId} did not confirm pasted prompt before submit (${placeholder.kind})`,
    }
  }

  if (!io.write('\r')) {
    return {
      ok: false,
      message: `Could not submit orchestration prompt to session ${io.sessionId}`,
    }
  }
  return { ok: true }
}
