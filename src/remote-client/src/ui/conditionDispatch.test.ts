import { describe, expect, it, vi } from 'vitest'

import { phoneConditionHandlers } from './conditionDispatch'
import type { PhoneConditionFeed } from './conditionDispatch'
import { makeOutletDispatch } from '@shared/conditions-core/dispatch'
import type { ConditionAction } from '@shared/conditions-core/contract'

// The phone half of #1070. Until this file existed the ONLY way to reach this
// code was to mount the whole session screen, so nothing asserted that a
// refused answer says anything on the phone at all — which is the exact bug
// #1070 is about, one surface further out.
//
// The refusal shapes below are the ones `RemoteServer.applyPermissionReply`
// really puts on the wire: `reason` as the resolver's own word, `failedAtStep`
// when the multi-step driver got partway. An older host that only sends the
// flattened `error` string is covered by the last case.

const answer: ConditionAction = {
  kind: 'custom',
  id: 'answer',
  label: 'Use TypeScript',
  name: 'claude.askUserQuestion.answer',
  payload: { answers: [] },
}

const key: ConditionAction = { kind: 'pty', id: 'yes', label: 'Yes', data: '1' }

function harness(feed: Partial<PhoneConditionFeed>) {
  const errors: (string | null)[] = []
  const handlers = phoneConditionHandlers(
    {
      replyWithPtyAction: vi.fn(async () => ({ ok: true })),
      resolveCondition: vi.fn(async () => ({ ok: true })),
      ...feed,
    } as PhoneConditionFeed,
    'session-1',
    message => errors.push(message),
  )
  // Driven through the SAME dispatcher the shared ProviderConditionOutlet
  // builds (#1177), so these cases exercise what a phone tap really runs.
  const dispatch = makeOutletDispatch(handlers.onPtyAction, handlers.onResolveCustom, handlers.onConditionRefused)
  // `errors` keeps every call, not just the last, so the "cleared first" step
  // is observable: a dispatch that never cleared would leave the array without
  // its leading null and still end on the right message.
  return { dispatch, errors, shown: () => errors.filter((e): e is string => e !== null) }
}

describe('phone condition dispatch', () => {
  it('says what to do about a replaced question, not which step failed', async () => {
    const { dispatch, errors, shown } = harness({
      resolveCondition: vi.fn(async () => ({
        ok: false,
        reason: 'option-not-found',
        failedAtStep: 'select-option',
      })),
    })

    await dispatch(answer)

    expect(errors[0]).toBeNull()
    expect(shown()).toEqual([
      'That answer no longer matches what the agent is asking. Read the question again and answer it.',
    ])
    // The internal token must not reach the screen — it was the whole message
    // before #1099.
    expect(shown()[0]).not.toContain('option-not-found')
    expect(shown()[0]).not.toContain('select-option')
  })

  it('names the dead agent rather than the transport', async () => {
    const { dispatch, shown } = harness({
      resolveCondition: vi.fn(async () => ({ ok: false, reason: 'no-headless' })),
    })

    await dispatch(answer)

    expect(shown()).toEqual([
      'This agent is no longer running, so it cannot receive that answer. Reload it.',
    ])
  })

  it('still shows a provider reason this app has never heard of', async () => {
    // Grok and OpenCode Terminal really do answer `stale`, `closed` and
    // `no-live-channel`; `ConditionActionResult.reason` is a plain string in
    // both headless packages. Before the membership check these fell through
    // the describer's switch and rendered nothing.
    const { dispatch, shown } = harness({
      resolveCondition: vi.fn(async () => ({ ok: false, reason: 'no-live-channel' })),
    })

    await dispatch(answer)

    expect(shown()).toEqual([
      'The agent refused that answer (no-live-channel). Read the question again and answer it.',
    ])
  })

  it('keeps the phone silent when the answer landed', async () => {
    const resolveCondition = vi.fn(async () => ({ ok: true, state: { visible: false } }))
    const { dispatch, errors } = harness({ resolveCondition })

    await dispatch(answer)

    expect(resolveCondition).toHaveBeenCalledWith('session-1', answer)
    expect(errors).toEqual([null])
  })

  it('reports a pty reply the desktop could not match, and clears it on the next try', async () => {
    const replyWithPtyAction = vi.fn(async () => ({ ok: false, error: 'no such action on the live menu' }))
    const { dispatch, errors, shown } = harness({ replyWithPtyAction })

    await dispatch(key)
    expect(replyWithPtyAction).toHaveBeenCalledWith('session-1', key)
    expect(shown()).toEqual(['no such action on the live menu'])

    replyWithPtyAction.mockResolvedValueOnce({ ok: true } as never)
    await dispatch(key)
    // Second dispatch cleared the first refusal: without the clear, a stale
    // message would sit under a button that has since worked.
    expect(errors[errors.length - 1]).toBeNull()
  })

  it('falls back when an older host sends a bare failure', async () => {
    const { dispatch, shown } = harness({
      replyWithPtyAction: vi.fn(async () => ({ ok: false })),
    })

    await dispatch(key)

    expect(shown()).toEqual(['Action failed — it may have expired.'])
  })
})
