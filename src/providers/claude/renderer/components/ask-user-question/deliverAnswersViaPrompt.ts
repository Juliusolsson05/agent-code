// The "answer via message" send sequence: dismiss the AskUserQuestion picker
// with Esc, then deliver the structured XML answer as a normal prompt.
// See docs/decomposition/2026-07-23-auq-answer-via-prompt.md.
//
// WHY this is detached (fire-and-forget) and NOT owned by React state:
// pressing Esc cancels the AskUserQuestion tool, which lands a tool_result and
// UNMOUNTS the AskUserQuestion row almost immediately. So this sequence cannot
// depend on the row staying mounted — it takes only the two feed primitives and
// a session id, runs to completion on its own, and never calls back into React
// state. The caller latches its own double-submit guard before invoking.

import type { PromptDeliveryResult } from '@shared/types/providerConfig'

// Just the two feed methods this needs — kept minimal so the sequence is unit
// testable with a fake, independent of the full SessionFeed.
export type AnswerSendFeed = {
  sendInput(sessionId: string, data: string): Promise<boolean>
  deliverPrompt(sessionId: string, prompt: string): Promise<PromptDeliveryResult>
}

const ESC = String.fromCharCode(27) // Esc

// Tunables. The retry exists for ONE race: after Esc, the headless needs a
// moment to re-parse the dismissed picker. Until it does, `deliverPrompt`'s
// readiness gate reports the condition still blocking and returns
// `retry-after-resolve` with NOTHING written (`retrySafe: true`) — no
// corruption, just "too early". We retry only that case, only while the write
// was provably not made, so there is zero duplicate-prompt risk. ~2s total is
// comfortably longer than a TUI repaint.
const MAX_ATTEMPTS = 14
const RETRY_DELAY_MS = 150

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export type DeliverOutcome =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Esc-dismiss the picker, then deliver `prompt`, retrying only the
 * picker-not-cleared-yet race. Resolves when the prompt is accepted, or with a
 * reason when it could not be delivered.
 */
export async function deliverAnswersViaPrompt(
  feed: AnswerSendFeed,
  sessionId: string,
  prompt: string,
): Promise<DeliverOutcome> {
  // Esc first — while the picker owns the screen no prompt delivery is in
  // flight, so this write is never gated. It must precede any delivery so the
  // delivery is the session's first (and only) write reservation; never try to
  // write the prompt "through" an active picker.
  await feed.sendInput(sessionId, ESC)

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const result = await feed.deliverPrompt(sessionId, prompt)
    if (result.ok) return { ok: true }
    // Only "the picker has not cleared yet" is retryable, and only while no
    // bytes were written. Anything else (session unusable, partial write) must
    // NOT be retried — surfacing the reason is safer than a duplicate prompt.
    const raceable = result.disposition === 'retry-after-resolve' && result.retrySafe
    if (!raceable) return { ok: false, reason: result.message }
    await sleep(RETRY_DELAY_MS)
  }
  return { ok: false, reason: 'Timed out waiting for the picker to close before sending the answer.' }
}
