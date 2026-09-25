// The phone's condition handlers — what the SHARED ProviderConditionOutlet
// needs from the phone (#1177).
//
// WHY it is its own module and not inline in SessionView (#1099 review): this
// is the whole of the phone's refusal-reporting behaviour, and while it lived
// inside SessionView the only way to reach it was to mount the entire phone
// screen. As free functions over two feed methods and a `setError` sink it is
// driven directly by a fake feed.
//
// WHY a pty choice goes out as the whole ACTION: the phone wire refuses
// arbitrary bytes. A pty reply must carry the action's own `{id,label,data}`
// so the desktop can verify it against the live condition menu. The phone
// used to keep its own dispatcher and mount the core outlet directly for this
// reason, because the shared outlet's dispatcher collapsed a pty action to
// bytes. Since #1177 that dispatcher (makeOutletDispatch) hands each surface
// the whole action, so the phone mounts the same provider outlet as the
// desktop — with the provider's normalized snapshot and render-shape
// observation — and supplies only these handlers.

import { describeConditionRefusal } from '@shared/conditions-core/dispatch'
import type { ConditionRefusalReporter } from '@shared/conditions-core/dispatch'
import type { ConditionCustomAction, ConditionPtyAction } from '@shared/conditions-core/contract'

/** Just the two feed methods this needs, so a test can supply both. */
export type PhoneConditionFeed = {
  replyWithPtyAction(
    sessionId: string,
    action: { kind: 'pty'; id: string; label: string; data: string },
  ): Promise<{ ok: boolean; error?: string }>
  resolveCondition(sessionId: string, action: ConditionCustomAction): Promise<unknown>
}

export type PhoneConditionHandlers = {
  onPtyAction: (action: ConditionPtyAction) => Promise<void>
  onResolveCustom: (action: ConditionCustomAction) => Promise<unknown>
  onConditionRefused: ConditionRefusalReporter
}

/**
 * `setError` is the phone's one message surface for this: an inline error
 * line on the session screen. Both arms clear it before acting, so a stale
 * refusal from the previous click cannot be read as the answer to this one.
 */
export function phoneConditionHandlers(
  feed: PhoneConditionFeed,
  sessionId: string,
  setError: (message: string | null) => void,
): PhoneConditionHandlers {
  return {
    onPtyAction: async action => {
      setError(null)
      // pty replies carry a flat `error`; there is no structured refusal on
      // this arm because the desktop either matched the action against the
      // live menu and wrote it, or it did not.
      const r = await feed.replyWithPtyAction(sessionId, action)
      if (!r.ok) setError(r.error ?? 'Action failed — it may have expired.')
    },
    onResolveCustom: async action => {
      setError(null)
      return await feed.resolveCondition(sessionId, action)
    },
    // The SHARED description, so the phone and the app say the same thing
    // about the same refusal (#1070).
    onConditionRefused: refusal => setError(describeConditionRefusal(refusal)),
  }
}
