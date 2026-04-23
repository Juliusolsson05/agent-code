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
// a paste gets delivered in TWO phases — first the payload, then
// (after Claude's own paste debounce window has elapsed) the submit
// key. This keeps us aligned with Claude's existing placeholder /
// expansion model instead of fighting it.
//
// Why these numbers:
//   - 800 chars matches Claude's current PASTE_THRESHOLD upstream.
//   - 125ms is slightly above Claude's 100ms paste completion timeout.
//     Going lower risks reintroducing the race; going much higher
//     makes submit feel laggy on every long paste.

export const CLAUDE_PASTE_THRESHOLD = 800
export const CLAUDE_PASTE_SUBMIT_DELAY_MS = 125
export const CLAUDE_IMAGE_PATH_SUBMIT_DELAY_MS = 750

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function sendBracketedPaste(
  send: (data: string) => Promise<void>,
  payload: string,
): Promise<void> {
  await send(`\x1b[200~${payload}\x1b[201~`)
}

export async function sendBracketedPasteThenSubmit(
  send: (data: string) => Promise<void>,
  payload: string,
  delayMs = 0,
): Promise<void> {
  if (delayMs <= 0) {
    await send(`\x1b[200~${payload}\x1b[201~\r`)
    return
  }
  await sendBracketedPaste(send, payload)
  await wait(delayMs)
  await send('\r')
}

export async function sendClaudeDraftText(
  send: (data: string) => Promise<void>,
  text: string,
): Promise<void> {
  if (text.length === 0) return
  const isPasteLike = text.includes('\n') || text.length > CLAUDE_PASTE_THRESHOLD
  if (isPasteLike) {
    await sendBracketedPaste(send, text)
    await wait(CLAUDE_PASTE_SUBMIT_DELAY_MS)
    return
  }
  await send(text)
}

export function buildClaudeImagePastePayload(text: string, imagePaths: string[]): string {
  if (imagePaths.length === 0) return text
  if (text.trim().length === 0) return imagePaths.join('\n')
  return `${imagePaths.join('\n')}\n${text}`
}
