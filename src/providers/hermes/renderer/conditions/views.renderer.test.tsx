import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { HermesRequest } from 'hermes-headless'
import { inboundFrames, latestRecording } from 'hermes-headless/testing/corpus'
import { conditionRecord } from '@providers/hermes/runtime/hermesSession'
import { hermesApprovalView, hermesClarifyView, hermesSecretView } from '@providers/hermes/renderer/conditions/views'
import { HERMES_ANSWER, validateAnswer } from '@providers/hermes/runtime/requestAnswers'
import type { ConditionAction, ConditionCustomAction } from '@shared/conditions-core/contract'

// The cards render the condition records HermesSession builds from RECORDED
// requests (hermes-headless research/corpus S5 approval, S6 clarify/secret).
// What a card dispatches is then checked against the runtime's validator, the
// trust boundary that makes a view able to compose an answer but not invent one.

function request(method: string, scenario: string): HermesRequest {
  const frame = inboundFrames(latestRecording(scenario)).find((entry) => entry.method === method)!
  return { id: String(frame.id), method: method as HermesRequest['method'], params: frame.params as Record<string, unknown>, replayed: false }
}

function mount(view: { Component: React.ComponentType<{ state: unknown; actions: ConditionAction[]; dispatch: (action: ConditionAction) => Promise<void>; interactionActive: boolean }> }, req: HermesRequest) {
  const record = conditionRecord(req, 0)
  const dispatch = vi.fn(async (_action: ConditionAction) => undefined)
  const View = view.Component
  render(<View state={record.state} actions={record.actions} dispatch={dispatch} interactionActive />)
  return dispatch
}

describe('Hermes condition cards', () => {
  it('approval: shows the redacted command and answers with one of Hermes\' offered choices', () => {
    const req = request('approval', 'S5')
    const dispatch = mount(hermesApprovalView as never, req)
    expect(screen.getByText(/rm -r \/tmp\/hh-approval-probe-dir-does-not-exist/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    const action = dispatch.mock.calls[0]![0] as ConditionCustomAction
    expect(validateAnswer(req, (action.payload as { result: unknown }).result)).toEqual({ choice: 'once' })
  })

  it('clarify with several questions: composes one answer set Hermes will accept', () => {
    const req = request('clarify', 'S6')
    const dispatch = mount(hermesClarifyView as never, req)
    // Recorded: q0 single choice ("red (Recommended)", "blue"), q1 multi
    // ("a (Recommended)", "b", "c"), q2 free text. The expected answers are
    // what Hermes' own client sent in that recording: bare labels.
    fireEvent.click(screen.getByRole('button', { name: 'blue' }))
    fireEvent.click(screen.getByRole('button', { name: 'a (Recommended)' }))
    fireEvent.click(screen.getByRole('button', { name: 'c' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'nothing else' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }))
    const action = dispatch.mock.calls[0]![0] as ConditionCustomAction
    expect(action.name).toBe(HERMES_ANSWER)
    expect(validateAnswer(req, (action.payload as { result: unknown }).result)).toEqual({
      answers: { q0: 'blue', q1: 'a, c', q2: 'nothing else' },
    })
  })

  it('secret: masks the input, sends the typed value once and clears it', () => {
    const req = request('secret', 'S6')
    const dispatch = mount(hermesSecretView as never, req)
    // Named after the variable Hermes will store it in (recorded env_var).
    const input = screen.getByLabelText('Hermes needs HH_TEST_TOKEN', { selector: 'input' }) as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'typed-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const action = dispatch.mock.calls[0]![0] as ConditionCustomAction
    expect(validateAnswer(req, (action.payload as { result: unknown }).result)).toEqual({ value: 'typed-secret' })
    expect(input.value).toBe('')
  })

  it('clarify: a NEW question never inherits the previous one\'s choices', () => {
    // Mechanical mutation of S6: the same questions under a new request id,
    // as when Hermes asks again after a timeout.
    const req = request('clarify', 'S6')
    const record = conditionRecord(req, 0)
    const View = hermesClarifyView.Component as React.ComponentType<{ state: unknown; actions: ConditionAction[]; dispatch: (action: ConditionAction) => Promise<void>; interactionActive: boolean }>
    const dispatch = vi.fn(async (_action: ConditionAction) => undefined)
    const { rerender } = render(<View state={record.state} actions={record.actions} dispatch={dispatch} interactionActive />)
    fireEvent.click(screen.getByRole('button', { name: 'blue' }))
    expect(screen.getByRole('button', { name: 'blue' }).getAttribute('aria-pressed')).toBe('true')
    const next = conditionRecord({ ...req, id: `${req.id}-again` }, 0)
    rerender(<View state={next.state} actions={next.actions} dispatch={dispatch} interactionActive />)
    expect(screen.getByRole('button', { name: 'blue' }).getAttribute('aria-pressed')).toBe('false')
  })
})
