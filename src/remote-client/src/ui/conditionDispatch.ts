// The phone's condition dispatch, lifted out of SessionView.
//
// WHY it is its own module and not an inline `useCallback` (#1099 review):
// this is the whole of the phone's refusal-reporting behaviour, and while it
// lived inside SessionView the only way to reach it was to mount the entire
// phone screen — websocket feed, transcript store, dictation, reader mode and
// all. Nothing tested it, so the phone half of "a refused answer must say why"
// was asserted precisely nowhere. As a free function over two feed methods and
// a `setError` sink, it is driven directly by a fake feed.
//
// WHY it is NOT `makeDispatchFromOnSend`: the phone wire refuses arbitrary
// bytes. A pty reply must carry the action's own `{id,label,data}` so the
// desktop can verify it against the live condition menu, and
// `makeDispatchFromOnSend` collapses a pty action to bytes and throws the id
// away. That is also why the phone mounts the core `ConditionOutlet` directly
// rather than `ProviderConditionOutlet`.

import { describeConditionRefusal, refusalOf } from '@shared/conditions-core/dispatch'
import type { ConditionAction, ConditionCustomAction } from '@shared/conditions-core/contract'

/** Just the two feed methods this needs, so a test can supply both. */
export type PhoneConditionFeed = {
  replyWithPtyAction(
    sessionId: string,
    action: { kind: 'pty'; id: string; label: string; data: string },
  ): Promise<{ ok: boolean; error?: string }>
  resolveCondition(sessionId: string, action: ConditionCustomAction): Promise<unknown>
}

/**
 * Build the `(action) => Promise<void>` the core ConditionOutlet drives.
 *
 * `setError` is the phone's one message surface for this: an inline error line
 * on the session screen. It is cleared on every dispatch so a stale refusal
 * from the previous click cannot be read as the answer to this one.
 */
export function makePhoneConditionDispatch(
  feed: PhoneConditionFeed,
  sessionId: string,
  setError: (message: string | null) => void,
): (action: ConditionAction) => Promise<void> {
  return async (action: ConditionAction): Promise<void> => {
    setError(null)
    if (action.kind === 'pty') {
      // pty replies carry a flat `error`; there is no structured refusal on
      // this arm because the desktop either matched the action against the
      // live menu and wrote it, or it did not.
      const r = await feed.replyWithPtyAction(sessionId, action)
      if (!r.ok) setError(r.error ?? 'Action failed — it may have expired.')
      return
    }
    const r = await feed.resolveCondition(sessionId, action)
    // The SHARED description, so the phone and the app say the same thing
    // about the same refusal (#1070). This was `failedAtStep` alone, which
    // names an internal step rather than telling the person what to do — and
    // `failedAtStep` is absent for most reasons, so the common case rendered
    // the generic fallback.
    const refusal = refusalOf(action, r)
    if (refusal) setError(describeConditionRefusal(refusal))
  }
}
