// Claude prompt-delivery protocol (#394 phase 2c). Extracted from the
// inline `if (kind === 'claude')` branch of MCP's submitPrompt so the
// protocol lives with the provider that owns it.
//
// WHY bracketed paste instead of plain keystrokes: prompts can be long,
// markdown-heavy, or multi-line. Raw keystrokes would let the TUI interpret
// newlines/escapes as interactive input. Bracketed paste is the same
// terminal-level contract the composer uses for large prompts.
//
// WHY Claude waits AFTER the paste (unlike Codex, which gates BEFORE):
// Claude's known race is paste-commit ordering — the composer is present, but
// Enter can arrive before Claude's ~100ms paste accumulator has committed the
// payload, so the `\r` is swallowed as more paste content and the prompt just
// sits in the composer. We send Enter only once the composer VISIBLY committed
// the paste. The delivery boundary the caller relies on: `ok: true` means the
// prompt was pasted, confirmed, and submitted.
//
// WHY the confirm is placeholder-OR-inline (this file's bug history):
// Claude reflects a committed paste two ways and which one depends on size —
// COLLAPSE into a `[Pasted text #N]` placeholder (only big pastes: single-line
// >~800 chars, or multiline >=~4 lines), or INLINE as raw text with NO
// placeholder (everything smaller). This module used to wait for the
// placeholder ONLY (awaitPastePlaceholder). That was fine while its only
// caller was orchestration sending long markdown bootstraps that always
// collapse — but the remote/mobile companion routes ARBITRARY, mostly SHORT
// prompts here, and every dictated prompt is multi-line (the <stt>…</stt>
// wrapper adds newlines → always the paste route). Those inline with no
// placeholder, so the old probe timed out unconfirmed ("did not confirm pasted
// prompt before submit") and the message stuck in the composer — the
// never-ending "remote send doesn't work" bug. We now use the SAME
// content-match the desktop composer uses: placeholder OR inline tail, from the
// shared detector. Characterized against a real `claude` PTY in tmp/paste-repro.

import type {
  PromptDeliveryIo,
  PromptDeliveryResult,
} from '@shared/types/providerConfig.js'
import { isPasteLike, pollPasteAbsorbed } from '@shared/claude/pasteConfirm.js'

// Detection bound. The inline tail / new placeholder appears in ~10–30ms
// (measured), so this is only a safety floor for the pathological case where
// NEITHER signal ever materializes (a future Claude UI change) — we fail
// visibly rather than hang. snapshotScreen is a synchronous in-process read, so
// polling is cheap.
const CONFIRM_TIMEOUT_MS = 2000
const CONFIRM_POLL_INTERVAL_MS = 10

export async function deliverClaudePrompt(
  io: PromptDeliveryIo,
): Promise<PromptDeliveryResult> {
  // Plain fast path: short single-line text can't engage Claude's paste
  // accumulator, so text + Enter in ONE write is safe — there is no paste to
  // race. `isPasteLike` is the shared routing predicate (was duplicated here;
  // now one source with the desktop composer).
  if (!isPasteLike(io.prompt)) {
    if (!io.write(`${io.prompt}\r`)) {
      return {
        ok: false,
        message: `Could not write prompt to session ${io.sessionId}`,
      }
    }
    return { ok: true }
  }

  // Paste route. Capture the composer screen BEFORE the paste so the detector
  // keys on the *transition* (a NEW placeholder / the tail NEWLY inlined) — and
  // so a SECOND paste in the session ignores the first paste's stale
  // `[Pasted text #1]` placeholder instead of false-confirming on it.
  //
  // snapshotScreen is a typed optional on AgentSession; a Claude runtime build
  // that loses it degrades to a visible delivery failure here, not a TypeError.
  if (typeof io.session.snapshotScreen !== 'function') {
    return {
      ok: false,
      message: `Claude session ${io.sessionId} has no screen snapshot (headless unavailable?)`,
    }
  }
  const baselineScreen = io.session.snapshotScreen()

  if (!io.write(`\x1b[200~${io.prompt}\x1b[201~`)) {
    return {
      ok: false,
      message: `Could not write paste to session ${io.sessionId}`,
    }
  }

  const outcome = await pollPasteAbsorbed(
    () => io.session.snapshotScreen?.() ?? '',
    baselineScreen,
    io.prompt,
    { timeoutMs: CONFIRM_TIMEOUT_MS, pollIntervalMs: CONFIRM_POLL_INTERVAL_MS },
  )
  if (outcome.kind !== 'absorbed') {
    return {
      ok: false,
      message: `Claude session ${io.sessionId} did not confirm pasted prompt before submit (${outcome.kind})`,
    }
  }

  if (!io.write('\r')) {
    return {
      ok: false,
      message: `Could not submit prompt to session ${io.sessionId}`,
    }
  }
  return { ok: true }
}
