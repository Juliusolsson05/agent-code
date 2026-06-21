// conditions-core / dispatch.ts
//
// The dispatch driver: turns a chosen ConditionAction into a real side effect.
//
// WHY only the pty arm is wired (and `custom` is intentionally dormant)
// --------------------------------------------------------------------
// Every condition that is LIVE today (Claude trust/permission/resume/compaction,
// Codex approval/trust) resolves by writing a raw keystroke string into the
// session PTY. That is the entire contract with the underlying provider TUI:
// the real terminal program reads '\r' / '3\r' / '\x1b' etc. and advances its
// own state machine. So the only arm that needs to do anything is `pty`, and it
// does exactly what every modal does today — call sendInput with the action's
// raw data.
//
// `custom` actions are part of the wire union (contract.ts) but NO live
// condition emits one. Wiring a "resolve via structured IPC" path now would
// mean inventing a `session:resolveCondition` channel and a main-side resolver
// with zero callers — dead code that could rot before its first real use. So
// the custom arm deliberately THROWS. The first PR that introduces a genuine
// custom condition will add the IPC + resolver and replace this throw. Keeping
// it loud-failing (rather than silently no-op) means we find out immediately if
// some future code path accidentally emits a custom action before that wiring
// exists.

import type { ConditionAction } from './contract'

// makeDispatch builds a dispatcher bound to a specific session, given a
// sendInput(sessionId, data) function (i.e. window.api.sendInput). Used when a
// caller has the sessionId in hand.
export function makeDispatch(
  sessionId: string,
  sendInput: (sessionId: string, data: string) => Promise<unknown>,
): (action: ConditionAction) => Promise<void> {
  return async (action: ConditionAction) => {
    if (action.kind === 'pty') {
      await sendInput(sessionId, action.data)
      return
    }
    // custom — intentionally dormant. See file header WHY.
    throw new Error('custom condition actions not yet wired')
  }
}

// makeDispatchFromOnSend builds a dispatcher from an ALREADY-session-bound
// `onSend(data)` callback (the shape TileLeaf passes down: `send` is already
// bound to the active session's id). This avoids having to re-thread sessionId
// through the outlet just to re-bind it — the pty arm calls onSend(data), which
// is byte-for-byte the same send path every modal uses today.
export function makeDispatchFromOnSend(
  onSend: (data: string) => Promise<void>,
): (action: ConditionAction) => Promise<void> {
  return async (action: ConditionAction) => {
    if (action.kind === 'pty') {
      await onSend(action.data)
      return
    }
    // custom — intentionally dormant. See file header WHY.
    throw new Error('custom condition actions not yet wired')
  }
}
