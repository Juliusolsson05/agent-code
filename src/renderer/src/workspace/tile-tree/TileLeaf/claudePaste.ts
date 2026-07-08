// Claude's TUI has its own paste-state machine. Large input and
// bracketed paste do NOT go straight from "bytes arrived" to "submit
// immediately" — Claude buffers every `isPasted` chunk and flushes on a
// ~100ms debounce (`PASTE_COMPLETION_TIMEOUT_MS` in claude-code-src).
// INSIDE that debounce window a `pastePendingRef` guard swallows every
// subsequent keystroke — INCLUDING our submit `\r` — as more paste
// content. So if the Enter lands before the debounce fires, it becomes
// literal text, no turn starts, and the user has to press Enter again.
// That is the exact user-facing bug:
//
//   1. the pasted prompt appears in Claude's composer,
//   2. Claude flips into a "working" looking state,
//   3. but no real turn starts,
//   4. and the NEXT Enter finally submits the already-buffered prompt.
//
// We fix this at the shell boundary instead of forking Claude's paste
// logic: deliver the paste in TWO phases — first the bracketed payload,
// then a separate submit `\r` only AFTER we can see Claude's composer
// has visibly absorbed the paste (the debounce has provably fired).
//
// ----------------------------------------------------------------------------
// THE SIGNAL IS A CONTENT MATCH, NOT A CLOCK.
// ----------------------------------------------------------------------------
//
// We compare what the user submitted against what is actually in the
// headless composer, via the live screen snapshot (`latestScreenRef`),
// and send `\r` the instant the composer reflects the paste. Two
// screen-truth manifestations, because Claude renders pastes two ways:
//
//   * COLLAPSE: a large paste becomes a `[Pasted text #N]` placeholder.
//     Signal: a NEW placeholder appeared vs. the pre-paste baseline.
//   * INLINE:  a medium paste (≈100 chars up to Claude's collapse
//     threshold) is inserted as raw text. NO placeholder ever renders —
//     this is the band that issue #279 / #90 kept failing on, because
//     the old detector only watched for the placeholder, timed out, and
//     blind-fired `\r` straight into the debounce. Signal: the paste's
//     tail newly appears in the composer.
//
// Both are load-independent: 10ms or 10s, we wait for the *condition*.
//
// The wall-clock wait survives ONLY as a rare safety floor — if neither
// signal materializes within a short bound (a future Claude UI rename,
// or a screen snapshot we can't read), we send `\r` anyway so submit
// degrades rather than hangs. It must never again be the primary path:
// real production traces show the timer races even at 1000ms under load,
// and "there's no value of T that's correct under all load conditions."
//
// Why these numbers:
//   - 100 chars: empirical lower bound where Claude's paste ACCUMULATOR
//     engages, independent of the inline-vs-collapse cutoff. Below this we
//     send raw `text + \r` in one write (the accumulator doesn't engage,
//     so the `\r` is safe).
//   - 125 ms floor: slightly above Claude's 100 ms debounce. Consulted
//     ONLY when the content match can't be made (the rare safety net).
//   - 500 ms detection bound: well past the 100 ms accumulator window, so
//     a real absorption always wins first; short enough that the rare
//     safety-net path still feels responsive.

import { sha8Web } from '@shared/code/sha8'
import {
  CLAUDE_PASTE_THRESHOLD,
  placeholderCount,
  pasteTailNeedle,
  pollPasteAbsorbed,
  type PasteAbsorbedOutcome,
} from '@shared/claude/pasteConfirm'

// The paste-commit DETECTION (placeholder-or-inline) now lives in the shared
// module that BOTH this desktop composer and the runtime delivery path consume
// — killing the drift that had left the runtime on a placeholder-only probe.
// Re-exported here so existing importers keep their `@renderer/.../claudePaste`
// import path. The battle-scarred TIMING constants below are unchanged.
export { CLAUDE_PASTE_THRESHOLD, placeholderCount, pasteTailNeedle }
export type { PasteAbsorbedOutcome }

export const CLAUDE_PASTE_SUBMIT_DELAY_MS = 125
export const CLAUDE_IMAGE_PATH_SUBMIT_DELAY_MS = 750
export const CLAUDE_PASTE_EVENT_DRIVEN_TIMEOUT_MS = 500
export const CLAUDE_PASTE_POLL_INTERVAL_MS = 10

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// SHA-256 prefix used as a fingerprint to correlate paste payloads
// across the renderer→IPC→main→PTY chain in the per-paste debug
// journal. crypto.subtle is the standard renderer-side digest API;
// 4 bytes is more than enough for cross-process pairing (collision
// probability is negligible for a single paste's chunk set).
const sha8 = sha8Web

// Content-match detection (placeholderCount / pasteTailNeedle /
// pollPasteAbsorbed) moved verbatim to @shared/claude/pasteConfirm so the
// runtime delivery path shares the exact same logic. Imported + re-exported at
// the top of this file.

export type ClaudePasteSendFn = (data: string, pasteId?: string) => Promise<void>

export type ClaudePasteOpts = {
  /** Renderer-minted UUID for the per-paste debug journal. When set,
   *  every PTY write in this paste emits an IPC:write event to the
   *  journal. */
  pasteId?: string
  /** Event-driven submit for Claude paste-like text. `getScreen` returns the
   *  live headless TUI snapshot so we can confirm the composer absorbed the
   *  paste before sending Enter. Optional in the type only because lower-level
   *  helpers are also used by Codex and image-path flows that do not need it. */
  eventDriven?: { enabled: boolean; getScreen: () => string | undefined }
}

export async function sendBracketedPaste(
  send: ClaudePasteSendFn,
  payload: string,
  opts?: ClaudePasteOpts,
): Promise<void> {
  const pasteId = opts?.pasteId
  if (pasteId) {
    window.api.recordPasteDebugEvent(pasteId, {
      layer: 'IPC',
      event: 'write:paste-payload',
      data: { bytes: payload.length, sha8: await sha8(payload) },
    })
  }
  await send(`\x1b[200~${payload}\x1b[201~`, pasteId)
}

export async function sendBracketedPasteThenSubmit(
  send: ClaudePasteSendFn,
  payload: string,
  delayMs = 0,
  opts?: ClaudePasteOpts,
): Promise<void> {
  const pasteId = opts?.pasteId
  const eventDriven = opts?.eventDriven

  // Single-write fast path. Used by callers that don't care about the
  // accumulator race (e.g. Codex, which has its own paste-state machine that
  // does NOT exhibit this bug). On Claude this branch is only taken when
  // `delayMs <= 0` AND event-driven is off — the composer call site always
  // sets event-driven, so in production this is codex-only.
  if (delayMs <= 0 && !eventDriven?.enabled) {
    if (pasteId) {
      window.api.recordPasteDebugEvent(pasteId, {
        layer: 'IPC',
        event: 'write:paste-and-submit-single',
        data: { bytes: payload.length, sha8: await sha8(payload) },
      })
    }
    await send(`\x1b[200~${payload}\x1b[201~\r`, pasteId)
    return
  }

  // Capture the composer baseline BEFORE writing the paste so the detector
  // keys on the placeholder/inline-text *transition*, not a stale match.
  const baselineScreen = eventDriven?.enabled ? (eventDriven.getScreen() ?? '') : ''

  await sendBracketedPaste(send, payload, opts)

  if (eventDriven?.enabled) {
    const outcome = await pollPasteAbsorbed(eventDriven.getScreen, baselineScreen, payload, {
      timeoutMs: CLAUDE_PASTE_EVENT_DRIVEN_TIMEOUT_MS,
      pollIntervalMs: CLAUDE_PASTE_POLL_INTERVAL_MS,
    })
    if (pasteId) {
      window.api.recordPasteDebugEvent(pasteId, {
        layer: 'SCREEN',
        event: outcome.kind === 'absorbed' ? 'paste:absorbed' : 'paste:absorb-timeout',
        data:
          outcome.kind === 'absorbed'
            ? { waitedMs: outcome.waitedMs, via: outcome.via }
            : {},
      })
    }
    if (outcome.kind === 'absorbed') {
      if (pasteId) {
        window.api.recordPasteDebugEvent(pasteId, {
          layer: 'IPC',
          event: 'write:submit-cr',
          data: { strategy: `event-driven:${outcome.via}`, waitedMs: outcome.waitedMs },
        })
      }
      await send('\r', pasteId)
      return
    }
    // Absorption not detected within the safety bound. Fall through to the
    // wall-clock floor — the rare safety net, NOT the primary path.
  }

  if (delayMs > 0) await wait(delayMs)
  if (pasteId) {
    window.api.recordPasteDebugEvent(pasteId, {
      layer: 'IPC',
      event: 'write:submit-cr',
      data: { strategy: 'wall-clock-floor', delayMs },
    })
  }
  await send('\r', pasteId)
}

export async function sendClaudeDraftText(
  send: ClaudePasteSendFn,
  text: string,
  opts?: ClaudePasteOpts,
): Promise<void> {
  if (text.length === 0) return
  const isPasteLike = text.includes('\n') || text.length > CLAUDE_PASTE_THRESHOLD
  if (isPasteLike) {
    await sendBracketedPaste(send, text, opts)
    await wait(CLAUDE_PASTE_SUBMIT_DELAY_MS)
    return
  }
  await send(text, opts?.pasteId)
}

export function buildClaudeImagePastePayload(text: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return text
  if (text.trim().length === 0) return imagePaths.join('\n')
  return `${imagePaths.join('\n')}\n${text}`
}
