import { useCallback, useEffect, useRef } from 'react'

// The recovery panel's actions (#1250 row 14). Three surfaces show one when
// an Agent Code-managed skill state file is unreadable: Settings → Skills,
// Conventions and Custom Skills. Each offers Reveal State File and Reset.
//
// WHY one gate for all of a panel's actions (#1424 review b, steering q111):
// all three surfaces dropped Reveal's answer at first; then, once answers
// were shown, a SLOWER earlier action could land last and overwrite a newer
// one (a late Reveal success clearing a newer Reset failure, and a late
// Reveal failure replacing it). Comparing message text fixed one order and
// not the other. The rule is now structural: every action on a panel takes a
// generation, and only the LATEST action's completion may speak. An older
// completion still applies its data (a reset's snapshot is the truth), but
// never its message.
//
// Main's reveal messages are fixed, curated strings, so they are shown as
// they are; a REJECTION is IPC text, so it gets fixed words instead (q22).

export const RECOVERY_REVEAL_FAILED = "Couldn't reveal the state file."
export const RECOVERY_RESET_FAILED = "Couldn't reset the state. Try again."

export type RevealResult = { ok: boolean; message?: string }

/** The message a reveal answer shows: null on success. */
export function revealMessage(result: RevealResult, fallback: string = RECOVERY_REVEAL_FAILED): string | null {
  return result.ok ? null : result.message ?? fallback
}

export type RecoveryActionGate = {
  /**
   * Run one panel action. `onLatest` runs when it completes and is still the
   * newest action; `onStale` (optional) when a newer action started meanwhile,
   * for data that must apply regardless; `onRejected` only when the rejection
   * is still the newest.
   */
  run: <T>(action: () => Promise<T>, handlers: {
    onLatest: (value: T) => void
    onStale?: (value: T) => void
    onRejected: () => void
  }) => Promise<void>
  /** Retire every in-flight action, e.g. when the recovery episode changes. */
  invalidate: () => void
}

export function useRecoveryActionGate(): RecoveryActionGate {
  const latest = useRef(0)
  const run = useCallback<RecoveryActionGate['run']>(async (action, { onLatest, onStale, onRejected }) => {
    const mine = ++latest.current
    let value
    try {
      value = await action()
    } catch {
      if (mine === latest.current) onRejected()
      return
    }
    if (mine === latest.current) onLatest(value)
    else onStale?.(value)
  }, [])
  const invalidate = useCallback(() => { latest.current += 1 }, [])
  return { run, invalidate }
}

/**
 * Clears an episode-local action message when the recovery it belongs to
 * changes or disappears (steering q111): a refusal about one state file must
 * not greet the user on the next recovery panel. Also retires in-flight
 * actions of the old episode, so none of them can speak into the new one.
 */
export function useRecoveryEpisode(identity: string | null, gate: RecoveryActionGate, clear: () => void): void {
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    gate.invalidate()
    clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity])
}
