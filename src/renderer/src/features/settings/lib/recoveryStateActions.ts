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

export async function revealRecoveryFile(
  reveal: () => Promise<{ ok: boolean; message?: string }>,
  setError: (message: string | null) => void,
): Promise<void> {
  try {
    const result = await reveal()
    setError(result.ok ? null : result.message ?? RECOVERY_REVEAL_FAILED)
  } catch {
    setError(RECOVERY_REVEAL_FAILED)
  }
}
