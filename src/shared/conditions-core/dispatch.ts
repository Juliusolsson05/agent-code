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
      // The sessionId-bound form is the control plane's, and a control caller
      // that cannot tell a refusal from an acceptance is worse than one that
      // says nothing.
      true,
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
        // `no-resolver` rather than a throw (#1099 review): a surface with no
        // resolver is a KNOWN refusal with its own message, and mapping it to
        // `dispatch-failed` told the user to "try again" at something that can
        // never work.
        if (!resolveCustom) return { ok: false, reason: 'no-resolver' }
        return await resolveCustom(action)
      },
      onRefused,
      // Views call `void dispatch(action)`; a rejection here is an unhandled
      // rejection on top of a silent failure.
      false,
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
  /** The provider refused with a reason this list does not know. */
  | 'unrecognised'

export type ConditionRefusal = {
  action: ConditionAction
  /**
   * The known reason, or `'unrecognised'` when the provider sent something
   * this list does not have (#1099 review).
   *
   * WHY that case is not hypothetical: `ConditionActionResult.reason` is typed
   * as a plain `string` in both headless packages, and Grok and OpenCode
   * Terminal really do emit `stale`, `closed`, `cancelled`, `no-live-channel`
   * and `request-failed`. Casting those into this union made the describer's
   * exhaustive switch fall through and return `undefined`, and `PaneToast`
   * renders nothing for an empty message — so the providers with the most
   * reachable refusal path stayed exactly as silent as before the fix.
   */
  reason: ConditionRefusalReason
  /** From an `aborted` resolver: which step of the resolve sequence failed.
   *  The useful half of a message, and previously thrown away with the rest. */
  failedAtStep?: string
  /** Exactly what the provider said, kept whether or not it is a known reason,
   *  so an unrecognised one can still be shown and reported. */
  rawReason: string
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
const KNOWN_REASONS: readonly ConditionRefusalReason[] = [
  'timeout', 'aborted', 'invalid-payload', 'option-not-found',
  'no-session', 'no-headless', 'no-resolver', 'dispatch-failed', 'unrecognised',
]

export function refusalOf(action: ConditionAction, result: unknown): ConditionRefusal | null {
  if (typeof result !== 'object' || result === null) return null
  const answer = result as { ok?: unknown; reason?: unknown; failedAtStep?: unknown }
  if (answer.ok !== false) return null
  const rawReason = typeof answer.reason === 'string' ? answer.reason : 'aborted'
  return {
    action,
    // Narrowed by MEMBERSHIP, not by a cast: a provider reason that is not on
    // the list becomes `unrecognised` and keeps its own words in `rawReason`.
    reason: KNOWN_REASONS.includes(rawReason as ConditionRefusalReason)
      ? rawReason as ConditionRefusalReason
      : 'unrecognised',
    rawReason,
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
    case 'unrecognised':
      // The provider's own word, because it is the only information there is —
      // and saying it is strictly better than the empty string this used to
      // return, which rendered no toast at all.
      return `The agent refused that answer (${refusal.rawReason}). Read the question again and answer it.`
  }
}

async function dispatchCustom(
  action: ConditionCustomAction,
  resolve: () => Promise<unknown>,
  onRefused: ConditionRefusalReporter | undefined,
  /**
   * Let a refusal REJECT rather than only be reported (#1099 review).
   *
   * The two callers need opposite things. Views call `void dispatch(action)`,
   * so a rejection there is an unhandled promise rejection on top of a silent
   * failure — they want the report. `sessions.conditionsReply` in
   * `main/sessions/conditionControl.ts` is not a view: it injects a resolver
   * that THROWS a `ControlError` on `{ok:false}` and relies on that rejection
   * to fail the capability. Swallowing it made a refused trust-dialog reply
   * answer `accepted: true` to an agent that then believed a folder was
   * trusted when it was not.
   */
  rethrow: boolean,
): Promise<void> {
  let result: unknown
  try {
    result = await resolve()
  } catch (err) {
    onRefused?.({ action, reason: 'dispatch-failed', rawReason: 'dispatch-failed' })
    if (rethrow) throw err
    // The view form deliberately does not rethrow (its callers do
    // `void dispatch(action)`), so without this line the ONLY record of an IPC
    // failure would be a toast saying "could not be delivered" — no stack, no
    // message, nothing to debug from (#1099 review). The reporter gets the
    // user-facing half; the console gets the cause.
    console.error('[conditions] custom action dispatch threw', action.name, err)
    return
  }
  const refusal = refusalOf(action, result)
  if (!refusal) return
  onRefused?.(refusal)
  if (rethrow) throw new Error(describeConditionRefusal(refusal))
}
