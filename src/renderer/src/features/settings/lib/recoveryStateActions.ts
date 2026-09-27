// The recovery panel's actions (#1250 row 14). Three surfaces show one when
// an Agent Code-managed skill state file is unreadable: Settings → Skills,
// Conventions and Custom Skills. Each offers Reveal State File and Reset.
//
// WHY one helper: all three dropped Reveal's answer. Main answers
// { ok: false, message } when there is nothing to reveal (the file was
// removed or reset meanwhile), and the click then did nothing visible.
// Main's messages are fixed, curated strings, so they are shown as they are;
// a REJECTION is IPC text, so it gets fixed words instead (q22).

export const RECOVERY_REVEAL_FAILED = "Couldn't reveal the state file."
export const RECOVERY_RESET_FAILED = "Couldn't reset the state. Try again."

type ErrorSetter = (next: string | null | ((current: string | null) => string | null)) => void

// The last message a reveal put on each row. WHY (#1424 review b): a reveal
// that SUCCEEDS used to clear the row's error unconditionally, so a slow
// reveal resolving after a failed Reset wiped the more important reset
// failure. A success now clears only the reveal's own earlier message.
const lastRevealMessage = new WeakMap<ErrorSetter, string>()

export async function revealRecoveryFile(
  reveal: () => Promise<{ ok: boolean; message?: string }>,
  setError: ErrorSetter,
  fallback: string = RECOVERY_REVEAL_FAILED,
): Promise<void> {
  let message: string | null
  try {
    const result = await reveal()
    message = result.ok ? null : result.message ?? fallback
  } catch {
    message = fallback
  }
  if (message !== null) {
    lastRevealMessage.set(setError, message)
    setError(message)
    return
  }
  const mine = lastRevealMessage.get(setError)
  lastRevealMessage.delete(setError)
  if (mine !== undefined) setError(current => (current === mine ? null : current))
}
