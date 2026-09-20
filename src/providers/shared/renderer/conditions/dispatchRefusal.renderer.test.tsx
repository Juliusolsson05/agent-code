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

  it('says something the person can act on for every reason', () => {
    // Exhaustiveness is the compiler's job (the switch has no default); this
    // pins that each reason says what happened AND what to do, and that no two
    // read the same — a refusal the user cannot act on is barely better than
    // the silence it replaces.
    const reasons: ConditionRefusalReason[] = [
      'timeout', 'aborted', 'invalid-payload', 'option-not-found',
      'no-session', 'no-headless', 'no-resolver', 'dispatch-failed',
    ]
    const messages = reasons.map(reason => describeConditionRefusal({ action, reason }))
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(20)
      expect(message).toMatch(/\.$/)
    }
    // Three pairs share wording ON PURPOSE, because they are the same thing to
    // the person reading it: option-not-found / invalid-payload both mean the
    // question moved on, no-session / no-headless both mean the agent is gone,
    // and aborted / dispatch-failed are both "it did not get there". Eight
    // reasons, five messages.
    expect(new Set(messages).size).toBe(5)
    // `failedAtStep` is the useful half of an aborted message and used to be
    // thrown away with the rest.
    expect(describeConditionRefusal({ action, reason: 'aborted', failedAtStep: 'permission.reply' }))
      .toContain('permission.reply')
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

    expect(refusals).toMatchObject([{ reason: 'dispatch-failed' }])
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
