import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  describeConditionRefusal,
  makeDispatchFromOnSend,
  refusalOf,
  type ConditionRefusal,
  type ConditionRefusalReason,
} from '@shared/conditions-core/dispatch'
import type { ConditionAction } from '@shared/conditions-core/contract'
import { makeDispatch } from '@shared/conditions-core/dispatch'
import { opencodeQuestionView } from '@providers/opencode/renderer/conditions/views'
import { ProviderConditionOutlet } from './ProviderConditionOutlet'
import type { OpencodeQuestionState } from '@shared/types/providerConditions'

// ---------------------------------------------------------------------------
// #1070. `dispatch` did `await resolveCustom(action)` and DISCARDED the answer,
// and every view calls `void dispatch(action)`. So a resolver that refused —
// `{ ok: false, reason: 'option-not-found' }` — produced no toast, no log and
// no state change: the button did nothing, and nothing anywhere said why.
//
// It became a path ordinary users hit when #1025 added the answer validator
// (correctly — it is the trust boundary that stops a renderer answering with a
// label the provider never offered). Click an option for a question the agent
// has just replaced and the click is refused, silently.
//
// A rejected resolver was worse than silent: with `void dispatch(...)` it was
// an unhandled promise rejection as well.
// ---------------------------------------------------------------------------

const action: ConditionAction = {
  kind: 'custom',
  id: 'q1:answer:Blue',
  label: 'Blue',
  name: 'opencode.question.reply',
  payload: { questionID: 'q1', answers: [['Blue']] },
}

afterEach(cleanup)

describe('reading a resolver’s answer (#1070)', () => {
  it.each([
    { name: 'a refusal with a reason', result: { ok: false, reason: 'option-not-found' }, reason: 'option-not-found' },
    { name: 'a refusal carrying the step it failed at', result: { ok: false, reason: 'aborted', failedAtStep: 'permission.reply' }, reason: 'aborted' },
    { name: 'a refusal with no reason at all', result: { ok: false }, reason: 'aborted' },
  ])('recognises $name', ({ result, reason }) => {
    expect(refusalOf(action, result)).toMatchObject({ reason })
  })

  it.each([
    { name: 'success', result: { ok: true } },
    { name: 'success with state', result: { ok: true, state: { questionID: 'q1' } } },
    // Deliberate: a resolver that answers something this code does not know is
    // NOT a refusal. Treating an unrecognised shape as failure would make
    // every click look refused the first time a provider returns something new.
    { name: 'an unrecognised shape', result: { delivered: true } },
    { name: 'nothing at all', result: undefined },
    { name: 'null', result: null },
  ])('does not invent a refusal from $name', ({ result }) => {
    expect(refusalOf(action, result)).toBeNull()
  })

  it.each([
    { reason: 'option-not-found', expect: /no longer matches/ },
    { reason: 'invalid-payload', expect: /no longer matches/ },
    { reason: 'timeout', expect: /did not accept that answer in time/ },
    { reason: 'no-session', expect: /no longer running/ },
    { reason: 'no-headless', expect: /no longer running/ },
    { reason: 'no-resolver', expect: /cannot receive that kind of answer/ },
    { reason: 'aborted', expect: /could not be delivered/ },
    { reason: 'dispatch-failed', expect: /could not be delivered/ },
  ] as Array<{ reason: ConditionRefusalReason; expect: RegExp }>)('maps $reason to the message that belongs to it', ({ reason, expect: pattern }) => {
    // Pinned PER REASON, because the first version only checked that each
    // message was long enough, ended in a full stop, and that there were five
    // distinct ones — so swapping `timeout`'s message with `no-session`'s left
    // the suite green while the app told a user to reload a running agent
    // (#1099 review).
    expect(describeConditionRefusal({ action, reason, rawReason: reason })).toMatch(pattern)
  })

  it('still says something when the provider sends a reason this list does not know', () => {
    // Grok and OpenCode Terminal really do emit `stale`, `closed`,
    // `cancelled`, `no-live-channel` and `request-failed` — both headless
    // packages type the field as a plain string. Casting those into the union
    // made the exhaustive switch fall through and return `undefined`, and
    // `PaneToast`/`GlobalToast` render nothing for an empty message. So the
    // providers with the MOST reachable refusal path stayed exactly as silent
    // as before the fix.
    for (const raw of ['stale', 'closed', 'cancelled', 'no-live-channel', 'request-failed']) {
      const refusal = refusalOf(action, { ok: false, reason: raw })!
      expect(refusal.reason).toBe('unrecognised')
      expect(refusal.rawReason).toBe(raw)
      const message = describeConditionRefusal(refusal)
      expect(message).toBeTruthy()
      // The provider's own word survives, because it is the only information
      // there is.
      expect(message).toContain(raw)
    }
  })

  it('carries failedAtStep out of the ANSWER, not just when a test hands it over', () => {
    // The "useful half" this fix set out to rescue. The only assertion about
    // it hand-built the refusal instead of going through `refusalOf`, so
    // dropping the capture entirely left the suite green.
    const refusal = refusalOf(action, { ok: false, reason: 'aborted', failedAtStep: 'permission.reply' })!

    expect(refusal.failedAtStep).toBe('permission.reply')
    expect(describeConditionRefusal(refusal)).toContain('permission.reply')
  })

  it.each([
    { name: 'an object', failedAtStep: { step: 'permission.reply' } },
    { name: 'a number', failedAtStep: 42 },
  ])('ignores a failedAtStep that is not a string: $name', ({ failedAtStep }) => {
    // Otherwise it is interpolated into user copy as `([object Object])`.
    const refusal = refusalOf(action, { ok: false, reason: 'aborted', failedAtStep })!

    expect(refusal.failedAtStep).toBeUndefined()
    expect(describeConditionRefusal(refusal)).not.toContain('object')
  })

  it('does not let a non-string reason reach the switch', () => {
    const refusal = refusalOf(action, { ok: false, reason: { code: 42 } })!

    expect(refusal.reason).toBe('aborted')
    expect(describeConditionRefusal(refusal)).toBeTruthy()
  })
})

describe('the dispatcher reports what it used to discard (#1070)', () => {
  it('reports a refusal, with the action that was refused', async () => {
    const refusals: ConditionRefusal[] = []
    const dispatch = makeDispatchFromOnSend(
      async () => {},
      async () => ({ ok: false, reason: 'option-not-found' }),
      refusal => refusals.push(refusal),
    )

    await dispatch(action)

    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject({ reason: 'option-not-found', action })
  })

  it('reports nothing when the resolver accepted', async () => {
    const onRefused = vi.fn()
    const dispatch = makeDispatchFromOnSend(async () => {}, async () => ({ ok: true }), onRefused)

    await dispatch(action)

    expect(onRefused).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'the resolver throws', resolve: async () => { throw new Error('ipc died') }, resolver: true },
    { name: 'no resolver is wired at all', resolve: undefined, resolver: false },
  ])('reports dispatch-failed and does NOT reject when $name', async ({ resolve, resolver }) => {
    // The `void dispatch(action)` contract: a rejection here is an unhandled
    // promise rejection on top of a silent failure. Both used to happen.
    const refusals: ConditionRefusal[] = []
    const dispatch = makeDispatchFromOnSend(
      async () => {},
      resolver ? resolve : undefined,
      refusal => refusals.push(refusal),
    )

    await expect(dispatch(action)).resolves.toBeUndefined()

    // A surface with no resolver is a KNOWN refusal with its own message —
    // telling the user to "try again" at something that can never work was the
    // worse of the two mappings (#1099 review).
    expect(refusals).toMatchObject([{ reason: resolver ? 'dispatch-failed' : 'no-resolver' }])
  })

  it('journals the cause of a swallowed throw, because the toast cannot carry it', async () => {
    // The view form deliberately does not rethrow. Without this line the only
    // record of an IPC failure is a toast saying "could not be delivered" — no
    // message, no stack, nothing to debug from (#1099 review). The user-facing
    // half goes to the reporter; the cause goes to the console.
    const journal = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = new Error('ipc died')
    const dispatch = makeDispatchFromOnSend(async () => {}, async () => { throw cause }, vi.fn())

    await dispatch(action)

    expect(journal).toHaveBeenCalledWith(expect.any(String), action.name, cause)
    journal.mockRestore()
  })

  it('leaves the pty arm alone, because its caller already answers for it', async () => {
    // `sendConditionKey` in TileLeaf reads main's boolean and shows a pane
    // toast for a write it could not make. Reporting here too would double the
    // message for the one arm that was never silent.
    const onRefused = vi.fn()
    const onSend = vi.fn(async () => {})
    const dispatch = makeDispatchFromOnSend(onSend, async () => ({ ok: false, reason: 'timeout' }), onRefused)

    await dispatch({ kind: 'pty', id: 'esc', label: 'Escape', data: '\u001b' })

    expect(onSend).toHaveBeenCalledWith('\u001b')
    expect(onRefused).not.toHaveBeenCalled()
  })
})

describe('a refused answer reaches the user through the real view (#1070)', () => {
  it('clicking an option the agent no longer offers says so', async () => {
    // End to end through the OpenCode question view, the real dispatcher and a
    // resolver that refuses exactly as the #1025 validator does when the
    // question has been replaced under the user.
    const refusals: ConditionRefusal[] = []
    const dispatch = makeDispatchFromOnSend(
      async () => {},
      async () => ({ ok: false, reason: 'option-not-found' }),
      refusal => refusals.push(refusal),
    )
    const state: OpencodeQuestionState = {
      visible: true,
      questionID: 'q1',
      questions: [{ header: 'Colour', question: 'Do you prefer red or blue?', options: [{ label: 'Red' }, { label: 'Blue' }] }],
    } as OpencodeQuestionState
    const Component = opencodeQuestionView.Component as (props: {
      state: OpencodeQuestionState
      actions: ConditionAction[]
      dispatch: (action: ConditionAction) => Promise<void>
    }) => JSX.Element | null
    render(<Component state={state} actions={[action]} dispatch={dispatch} />)

    fireEvent.click(screen.getByRole('button', { name: 'Blue' }))
    // The view fires `void dispatch(...)`, so the report lands a microtask later.
    await vi.waitFor(() => expect(refusals).toHaveLength(1))

    expect(describeConditionRefusal(refusals[0]!)).toMatch(/no longer matches/i)
  })

  it('reaches the user through the OUTLET, which is what wires the reporter', async () => {
    // The end-to-end one. The integration case above builds the dispatcher
    // itself, so it cannot tell whether `ProviderConditionOutlet` actually
    // passes the reporter down — and a mutation that dropped that argument
    // survived the whole suite until this existed.
    const refusals: ConditionRefusal[] = []
    render(
      <ProviderConditionOutlet
        sessionId="s1"
        conditions={{
          provider: 'opencode',
          conditions: {
            'opencode.question': {
              kind: 'opencode.question',
              state: {
                visible: true,
                questionID: 'q1',
                questions: [{ header: 'Colour', question: 'Do you prefer red or blue?', options: [{ label: 'Red' }, { label: 'Blue' }] }],
              },
              actions: [action],
            },
          },
        } as never}
        onSend={async () => {}}
        onResolveCustom={async () => ({ ok: false, reason: 'option-not-found' })}
        onConditionRefused={refusal => refusals.push(refusal)}
        interactionActive
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Blue' }))
    await vi.waitFor(() => expect(refusals).toHaveLength(1))

    expect(refusals[0]).toMatchObject({ reason: 'option-not-found' })
  })

})

describe('the control plane must still FAIL on a refusal (#1099 review)', () => {
  it('rejects, so `sessions.conditionsReply` cannot answer accepted:true', async () => {
    // `main/sessions/conditionControl.ts` is the one caller that is not a
    // `void dispatch(action)` view: it injects a resolver that throws a
    // `ControlError` on `{ok:false}` and relies on that rejection to fail the
    // capability. Swallowing it made a refused trust-dialog reply answer
    // `accepted: true` — so a root-management agent was told a folder had been
    // trusted when it had not.
    const refusals: ConditionRefusal[] = []
    const dispatch = makeDispatch(
      's1',
      async () => true,
      async () => { throw new Error('ControlError: failed') },
      refusal => refusals.push(refusal),
    )

    await expect(dispatch(action)).rejects.toThrow(/ControlError/)
    // And it is still reported, so a surface that wires a reporter sees it too.
    expect(refusals).toMatchObject([{ reason: 'dispatch-failed' }])
  })

  it('rejects for a refusal ANSWER as well, not only a thrown one', async () => {
    // The shape the control resolver actually produces for most refusals is a
    // throw, but a resolver that ANSWERS `{ok:false}` must not read as success
    // either.
    const dispatch = makeDispatch(
      's1',
      async () => true,
      async () => ({ ok: false, reason: 'option-not-found' }),
      undefined,
    )

    await expect(dispatch(action)).rejects.toThrow(/no longer matches/)
  })

  it('reports through the reporter the sessionId-bound form was given', async () => {
    const refusals: ConditionRefusal[] = []
    const dispatch = makeDispatch(
      's1',
      async () => true,
      async () => ({ ok: false, reason: 'timeout' }),
      refusal => refusals.push(refusal),
    )

    await expect(dispatch(action)).rejects.toThrow()

    expect(refusals).toMatchObject([{ reason: 'timeout' }])
  })
})

