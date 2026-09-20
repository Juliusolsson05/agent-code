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
  onRefused?: ConditionRefusalReporter,
): (action: ConditionAction) => Promise<void> {
  return async (action: ConditionAction) => {
    if (action.kind === 'pty') {
      await sendInput(sessionId, action.data)
      return
    }
    await dispatchCustom(
      action,
      async () => {
        if (!resolveCustom) throw new Error('custom condition action resolver missing')
        return await resolveCustom(sessionId, action)
      },
      onRefused,
    )
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
  onRefused?: ConditionRefusalReporter,
): (action: ConditionAction) => Promise<void> {
  return async (action: ConditionAction) => {
    if (action.kind === 'pty') {
      // The pty arm is NOT reported here. Its caller owns the answer: `onSend`
      // returns void because the app's own `sendConditionKey` already reads
      // main's boolean and shows a pane toast for a write it could not make.
      // Reporting it twice would double the message for the one arm that was
      // never silent.
      await onSend(action.data)
      return
    }
    await dispatchCustom(
      action,
      async () => {
        if (!resolveCustom) throw new Error('custom condition action resolver missing')
        return await resolveCustom(action)
      },
      onRefused,
    )
  }
}

// ---------------------------------------------------------------------------
// Refusals (#1070)
//
// A custom action's resolver ANSWERS: `{ ok: false, reason }` when the reply
// could not be delivered — a question that was replaced while the user was
// reading it, a session with no headless left, a payload the validator refused
// (which #1025 made reachable on an ordinary click). That answer used to be
// discarded here, and every view calls `void dispatch(action)`, so a refused
// action produced no toast, no log and no state change: the button simply did
// nothing, and nothing anywhere said why.
//
// The dispatcher reports instead of deciding. It cannot show a toast — it is
// shared by the app and the phone and must not know about either — so the
// caller passes a reporter and picks the surface. `describeConditionRefusal`
// is here so both surfaces say the same thing.
// ---------------------------------------------------------------------------

/** Every way a custom condition action can fail to take effect. */
export type ConditionRefusalReason =
  | 'timeout'
  | 'aborted'
  | 'invalid-payload'
  | 'option-not-found'
  | 'no-session'
  | 'no-headless'
  | 'no-resolver'
  /** The resolver threw rather than answering: IPC failed, or no resolver was
   *  wired at all. Named separately because it is OUR fault, not the
   *  provider's, and it reads differently in a bug report. */
  | 'dispatch-failed'

export type ConditionRefusal = {
  action: ConditionAction
  reason: ConditionRefusalReason
  /** From an `aborted` resolver: which step of the resolve sequence failed.
   *  The useful half of a message, and previously thrown away with the rest. */
  failedAtStep?: string
}

export type ConditionRefusalReporter = (refusal: ConditionRefusal) => void

/**
 * Narrow a resolver's `unknown` answer to a refusal, or null when it succeeded.
 *
 * WHY `unknown`: the resolver is injected and crosses IPC, so its result is
 * whatever came back over the wire. Treating an unrecognised shape as SUCCESS
 * is deliberate — a resolver that answers something new must not make every
 * click look refused.
 */
export function refusalOf(action: ConditionAction, result: unknown): ConditionRefusal | null {
  if (typeof result !== 'object' || result === null) return null
  const answer = result as { ok?: unknown; reason?: unknown; failedAtStep?: unknown }
  if (answer.ok !== false) return null
  const reason = typeof answer.reason === 'string' ? answer.reason : 'aborted'
  return {
    action,
    reason: reason as ConditionRefusalReason,
    ...(typeof answer.failedAtStep === 'string' ? { failedAtStep: answer.failedAtStep } : {}),
  }
}

/**
 * What to tell the person who clicked.
 *
 * Each line says what happened AND what to do, because a refusal the user
 * cannot act on is barely better than the silence it replaces. The
 * question-replaced wording covers the two reasons that mean exactly that:
 * `option-not-found` (the label is not on the current question) and
 * `invalid-payload` (the validator refused the shape, which on the question
 * path means the same thing).
 */
export function describeConditionRefusal(refusal: ConditionRefusal): string {
  switch (refusal.reason) {
    case 'option-not-found':
    case 'invalid-payload':
      return 'That answer no longer matches what the agent is asking. Read the question again and answer it.'
    case 'timeout':
      return 'The agent did not accept that answer in time. Try again.'
    case 'no-session':
    case 'no-headless':
      return 'This agent is no longer running, so it cannot receive that answer. Reload it.'
    case 'no-resolver':
      return 'This agent cannot receive that kind of answer. Answer it in the terminal instead.'
    case 'aborted':
    case 'dispatch-failed':
      return refusal.failedAtStep
        ? `That answer could not be delivered (${refusal.failedAtStep}). Try again.`
        : 'That answer could not be delivered. Try again.'
  }
}

async function dispatchCustom(
  action: ConditionCustomAction,
  resolve: () => Promise<unknown>,
  onRefused?: ConditionRefusalReporter,
): Promise<void> {
  let result: unknown
  try {
    result = await resolve()
  } catch {
    // Never rejects: every view calls `void dispatch(action)`, so a rejection
    // here is an unhandled promise rejection AND a silent failure at the same
    // time. Reporting it is strictly better than both.
    onRefused?.({ action, reason: 'dispatch-failed' })
    return
  }
  const refusal = refusalOf(action, result)
  if (refusal) onRefused?.(refusal)
}
