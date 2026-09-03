import type { SessionId } from '@renderer/workspace/types'

// Clears text sitting in the PROVIDER's own composer — the TUI input line,
// not Agent Code's textarea. Shared by the "Clear Agent Composer" palette
// command and the composer's Escape recovery path (#737) so the two cannot
// drift: the pane says "draft in agent composer" and refuses every send
// until that text is gone, and Agent Code will never overwrite a draft on
// its own (#683, #679).
//
// Ctrl+U, deliberately NOT Escape. `\x1b` is the byte the Stop button sends,
// and while the agent is mid-turn the provider reads it as an interrupt
// rather than a clear — clearing a draft must never be able to abort the
// agent's work.
//
// WHY each press is awaited and spaced instead of fired in a burst: the
// provider's input tokeniser accumulates a run of non-ESC bytes into ONE text
// token, and its control-letter branch only matches a single-character
// string. Two `\x15` bytes arriving in one PTY read are therefore not two
// kills — they are inserted as literal text. A tight 64-iteration loop would
// type garbage into the exact draft it is meant to remove, which is how the
// first cut of the palette command behaved.
//
// WHY a fixed count and not a loop that stops when the pane reports ready:
// callers close over a snapshot of the runtime, so a value read inside this
// async loop never updates. A readiness check here would either break
// immediately or never — it cannot observe the thing it claims to.
// Verification has to happen where the composer can actually be re-read,
// which is main, not here.
//
// Overshooting is free and undershooting is not, which settles the count.
// `deleteToLineStart` on an empty composer slices `text[0..0]` and kills the
// empty string — a genuine no-op. Stopping short, by contrast, leaves a
// half-killed prompt that a later Enter submits as a fragment. Kills reach
// the start of a VISUAL line, so a wrapped prompt needs one press per
// rendered row; 64 covers a long prompt at any realistic width.
export const CLEAR_AGENT_COMPOSER_PRESSES = 64
export const CLEAR_AGENT_COMPOSER_SPACING_MS = 25

// WHY one clear at a time per session: the spacing above is the whole
// mechanism. Two interleaved loops — a held key auto-repeating Escape, a
// second press because nothing visible happens for 1.6 s, the palette command
// invoked twice — would land `\x15` bytes under 25 ms apart, which the
// provider's tokeniser merges into one text token and INSERTS into the very
// draft being cleared. A second request while one is running is a no-op.
const clearing = new Set<SessionId>()

/** True while a clear routine is running for the session. */
export function isClearingAgentComposer(sessionId: SessionId): boolean {
  return clearing.has(sessionId)
}

export async function clearAgentComposer(
  sessionId: SessionId,
  sendInput: (sessionId: SessionId, data: string) => Promise<unknown> = (id, data) =>
    window.api.sendInput(id, data),
): Promise<void> {
  if (clearing.has(sessionId)) return
  clearing.add(sessionId)
  try {
    for (let press = 0; press < CLEAR_AGENT_COMPOSER_PRESSES; press += 1) {
      await sendInput(sessionId, '\x15')
      await new Promise(resolve => {
        setTimeout(resolve, CLEAR_AGENT_COMPOSER_SPACING_MS)
      })
    }
  } finally {
    clearing.delete(sessionId)
  }
}
