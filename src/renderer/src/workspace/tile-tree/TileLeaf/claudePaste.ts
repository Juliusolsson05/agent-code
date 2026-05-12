// Claude's TUI has its own paste-state machine. Large input and
// bracketed paste do NOT go straight from "bytes arrived" to "submit
// immediately" — Claude first buffers the paste, may collapse it into
// a `[Pasted text #N]` placeholder in the visible composer, and only
// later expands it back out during submit. If we send the paste
// payload AND the trailing Enter in the same PTY write, that Enter
// can land while Claude still considers the paste "in flight". The
// result is the exact user-facing bug we saw:
//
//   1. the pasted prompt appears in Claude's composer,
//   2. Claude flips into a "working" looking state,
//   3. but no real turn starts,
//   4. and the NEXT Enter finally submits the already-buffered prompt.
//
// We fix this at the shell boundary instead of forking Claude's paste
// logic: for Claude only, any prompt that is likely to be treated as
// a paste gets delivered in TWO phases — first the payload, then a
// separate submit write after Claude visibly acknowledges the paste.
//
// The primary strategy is event-driven and not user-configurable:
//
//   * EVENT-DRIVEN: poll Claude's screen snapshot for
//     `[Pasted text #N]` and send `\r` the instant the placeholder
//     appears. Load-independent — works at 10 ms or 10 s. This is
//     the strategy the paste-submit repro harness at
//     `vendor/in_progress/paste-submit-repro/` showed to be 10/10
//     reliable with average waits ~58 ms.
//
//   * WALL-CLOCK FALLBACK: wait `delayMs` (default 125 ms — slightly
//     above Claude's 100 ms paste completion timeout) then send `\r`.
//     Kept only as a fallback because the event-driven path depends on
//     Claude continuing to render the placeholder. A future Claude UI
//     rename should degrade paste-submit, not brick it entirely. The
//     harness shows the timer races even at 1000 ms under load, so it
//     must never be exposed as a selectable primary path again.
//
// Why these numbers:
//   - 100 chars: empirical lower bound on text length where Claude's
//     TUI runs its internal paste accumulator. The original constant
//     was 800 because we believed it had to match Claude's *collapse*
//     threshold (the size at which Claude renders `[Pasted text #N]`
//     instead of inlining the bytes). It does not. Claude's paste
//     ACCUMULATOR triggers independently, around ~100 chars, regardless
//     of whether the inlined-vs-collapse cutoff has been crossed. Real
//     per-paste debug dumps showed the bug recurring on 145 / 156 / 177
//     / 215-char single-line text that we were sending as
//     `route:claude-plain-text` (raw text + `\r` in one PTY write),
//     because Claude's accumulator engaged on the inline bytes and
//     swallowed the trailing `\r`. Lowering this to 100 routes those
//     cases through the bracketed-paste + event-driven path instead,
//     which is the bug fix.
//   - 125 ms is slightly above Claude's 100 ms paste completion
//     timeout. Going lower risks reintroducing the race; going much
//     higher makes submit feel laggy on every long paste. Only
//     consulted only when the event-driven path times out or cannot
//     reach the live Claude session.
//   - 500 ms event-driven safety bound (down from 2000 ms): for
//     bracketed pastes that DO NOT cross Claude's inline→collapse
//     threshold, the `[Pasted text #N]` placeholder never renders, so
//     our detector hits the timeout fallback every time. At 2000 ms
//     that became a noticeable per-submit lag on any text 100–800
//     chars — exactly the size range this PR moves into the
//     bracketed-paste path. 500 ms is well past Claude's 100 ms
//     accumulator window (so `\r` is always safe by then) and short
//     enough to feel responsive even on the slow-path fallback.

export const CLAUDE_PASTE_THRESHOLD = 100
export const CLAUDE_PASTE_SUBMIT_DELAY_MS = 125
export const CLAUDE_IMAGE_PATH_SUBMIT_DELAY_MS = 750
export const CLAUDE_PASTE_EVENT_DRIVEN_TIMEOUT_MS = 500

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// SHA-256 prefix used as a fingerprint to correlate paste payloads
// across the renderer→IPC→main→PTY chain in the per-paste debug
// journal. crypto.subtle is the standard renderer-side digest API;
// 4 bytes is more than enough for cross-process pairing (collision
// probability is negligible for a single paste's chunk set).
async function sha8(data: string): Promise<string> {
  const buf = new TextEncoder().encode(data)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  const hex: string[] = []
  for (const b of new Uint8Array(digest, 0, 4)) hex.push(b.toString(16).padStart(2, '0'))
  return hex.join('')
}

export type ClaudePasteSendFn = (data: string, pasteId?: string) => Promise<void>

export type ClaudePasteOpts = {
  /** Renderer-minted UUID for the per-paste debug journal. When set,
   *  every PTY write in this paste emits an IPC:write event to the
   *  journal. */
  pasteId?: string
  /** Event-driven submit for Claude paste-like text. The composer always
   *  provides this for Claude; optional in the type only because lower-level
   *  helpers are also used by Codex and image-path paste flows that must not
   *  wait for Claude's text placeholder. */
  eventDriven?: { enabled: boolean; sessionId: string }
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

  // Single-write fast path. Used by callers that don't care about
  // the placeholder race (e.g. Codex, which has its own paste-state
  // machine that does NOT exhibit this bug). Even on Claude we honor
  // this when explicitly opted in via `delayMs <= 0` — but the
  // composer call site in useComposerKeybinds always sets a positive
  // delay AND sets `eventDriven` so this branch is effectively
  // codex-only in production.
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

  await sendBracketedPaste(send, payload, opts)

  // Try the event-driven path first if enabled. The placeholder poll
  // happens main-side inside `awaitClaudePastePlaceholder` so we
  // don't pay an IPC round-trip per poll tick (10 ms cadence × 100s
  // of ms wait would be ~30 IPC msgs/paste otherwise).
  if (eventDriven?.enabled) {
    const outcome = await window.api.awaitClaudePastePlaceholder(
      eventDriven.sessionId,
      { timeoutMs: CLAUDE_PASTE_EVENT_DRIVEN_TIMEOUT_MS },
    )
    if (pasteId) {
      window.api.recordPasteDebugEvent(pasteId, {
        layer: 'SCREEN',
        event: outcome.kind === 'appeared'
          ? 'placeholder:appeared'
          : outcome.kind === 'timeout'
            ? 'placeholder:timeout'
            : 'placeholder:no-session',
        data: outcome.kind === 'appeared' ? { waitedMs: outcome.waitedMs } : {},
      })
    }
    if (outcome.kind === 'appeared') {
      if (pasteId) {
        window.api.recordPasteDebugEvent(pasteId, {
          layer: 'IPC',
          event: 'write:submit-cr',
          data: { strategy: 'event-driven', waitedMs: outcome.waitedMs },
        })
      }
      await send('\r', pasteId)
      return
    }
    // Fall through to the wall-clock path. We've already waited some
    // amount (up to `timeoutMs`) so subtract that from `delayMs` —
    // otherwise the timeout + delayMs add up to noticeable lag.
    // Floor at 0 in case the event-driven wait already exceeded delayMs.
    // We DON'T have the actual elapsed in the no-session/timeout
    // outcomes, but the timeout case took close to `timeoutMs`, so
    // skip the timer entirely there.
    if (outcome.kind === 'timeout') {
      if (pasteId) {
        window.api.recordPasteDebugEvent(pasteId, {
          layer: 'IPC',
          event: 'write:submit-cr',
          data: { strategy: 'timeout-skip-timer' },
        })
      }
      await send('\r', pasteId)
      return
    }
    // no-session: the renderer thinks we have a session but main
    // doesn't. Skip directly to the wall-clock path as a last-ditch.
  }

  if (delayMs > 0) await wait(delayMs)
  if (pasteId) {
    window.api.recordPasteDebugEvent(pasteId, {
      layer: 'IPC',
      event: 'write:submit-cr',
      data: { strategy: 'wall-clock-timer', delayMs },
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
