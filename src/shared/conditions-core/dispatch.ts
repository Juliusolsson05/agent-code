// conditions-core / dispatch.ts
//
// The dispatch driver: turns a chosen ConditionAction into a real side effect.
//
// WHY `custom` needs an explicit resolver callback
// ------------------------------------------------
// PTY actions are universal: every caller can write `action.data` into the
// session. Custom actions are different: they are structured requests that must
// route to the owning session's headless resolver (for PR-5, the
// AskUserQuestion driver that writes, reparses, and writes again). Keeping the
// resolver as an injected callback prevents this provider-agnostic helper from
// importing Electron IPC or knowing about `session:resolveCondition`.

import type { ConditionAction, ConditionCustomAction } from './contract'

type ResolveCustomAction = (action: ConditionCustomAction) => Promise<unknown>

// makeDispatch builds a dispatcher bound to a specific session, given a
// sendInput(sessionId, data) function (i.e. window.api.sendInput). Used when a
// caller has the sessionId in hand.
export function makeDispatch(
  sessionId: string,
  sendInput: (sessionId: string, data: string) => Promise<unknown>,
  resolveCustom?: (sessionId: string, action: ConditionCustomAction) => Promise<unknown>,
): (action: ConditionAction) => Promise<void> {
  return async (action: ConditionAction) => {
    if (action.kind === 'pty') {
      await sendInput(sessionId, action.data)
      return
    }
    if (!resolveCustom) throw new Error('custom condition action resolver missing')
    await resolveCustom(sessionId, action)
  }
}

// makeDispatchFromOnSend builds a dispatcher from an ALREADY-session-bound
// `onSend(data)` callback (the shape TileLeaf passes down: `send` is already
// bound to the active session's id). This avoids having to re-thread sessionId
// through the outlet just to re-bind it — the pty arm calls onSend(data), which
// is byte-for-byte the same send path every modal uses today.
export function makeDispatchFromOnSend(
  onSend: (data: string) => Promise<void>,
  resolveCustom?: ResolveCustomAction,
): (action: ConditionAction) => Promise<void> {
  return async (action: ConditionAction) => {
    if (action.kind === 'pty') {
      await onSend(action.data)
      return
    }
    if (!resolveCustom) throw new Error('custom condition action resolver missing')
    await resolveCustom(action)
  }
}
