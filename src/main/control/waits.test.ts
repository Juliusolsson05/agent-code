import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createWaitControl } from './waits'
import { agentStatusSchema, type ControlResult } from '@control-sdk'
const context = { requestId: 'read', caller: { kind: 'external' as const, id: 'operator' }, owner: { kind: 'main' as const, generation: 'main' } }
const owner = { kind: 'window' as const, windowId: 'second', generation: 'one' }
afterEach(() => vi.useRealTimers())
// WHY this goes through the producer's schema (#875): it used to hand-build
// `exited: false`, a value `agents.read` cannot emit — so the fixture agreed
// with the consumer's hand-written copy instead of with the app, and the suite
// was green while every `settled`/`attention` wait on an agent timed out.
const observation = (activity = 'running', run = 'run-one'): ControlResult => ({ ok: true, value: { observedAt: Date.now(), sessionRunId: run, providerSessionId: 'native', status: agentStatusSchema.parse({ process: 'running', activity, transcript: 'ready', inputReady: true, exited: null, conditions: [], queuedCount: 0, draftPresent: false }) }, operation: { callId: String(Date.now()), instanceId: 'host', owner, status: 'completed' } })
function setup(read = vi.fn().mockResolvedValue(observation())) {
  const host = createWaitControl(read)
  const execute = (id: string, input: unknown, caller = context.caller) => host.capabilities.find(cap => cap.descriptor.id === id)!.execute(input, { ...context, caller })
  const wait = (input: Record<string, unknown> = {}) => execute('observations.wait', { waitId: 'first', target: { kind: 'agent', sessionId: 'exact', owner }, timeoutMs: 500, ...input })
  return { host, read, execute, wait }
}
it('bounds a stalled renderer read by the whole deadline and preserves caller/owner', async () => {
  vi.useFakeTimers()
  const { wait, read } = setup(vi.fn(() => new Promise<ControlResult>(() => {})))
  const result = wait()
  await vi.advanceTimersByTimeAsync(500)
  expect(await result).toMatchObject({ ok: true, value: { status: 'timeout', snapshot: null } })
  expect(read).toHaveBeenCalledExactlyOnceWith({ capabilityId: 'agents.read', input: { sessionId: 'exact', depth: 'status' }, owner }, context.caller)
})
it('cancels in-flight reads only for the original caller and cancels on host disposal', async () => {
  const { host, wait, execute } = setup(vi.fn(() => new Promise<ControlResult>(() => {})))
  const result = wait()
  expect(await execute('observations.cancelWait', { waitId: 'first' }, { kind: 'external', id: 'other' })).toMatchObject({ ok: true, value: { cancelled: false } })
  expect(await execute('observations.cancelWait', { waitId: 'first' })).toMatchObject({ ok: true, value: { cancelled: true } })
  expect(await result).toMatchObject({ ok: true, value: { status: 'cancelled' } })
  const second = wait(); host.dispose()
  expect(await second).toMatchObject({ ok: true, value: { status: 'cancelled' } })
})
it('ignores changing read receipts, detects real status changes and invalidates backend/caller cursors', async () => {
  vi.useFakeTimers()
  const { wait, read, execute } = setup(vi.fn(async () => observation()))
  const first = wait()
  await vi.advanceTimersByTimeAsync(500)
  const result = await first
  expect(result).toMatchObject({ ok: true, value: { status: 'timeout' } })
  if (!result.ok) throw new Error('wait failed')
  const after = (result.value as { cursor: string }).cursor
  read.mockResolvedValue(observation('idle'))
  expect(await wait({ after })).toMatchObject({ ok: true, value: { status: 'changed' } })
  read.mockResolvedValue(observation('idle', 'replacement-run'))
  expect(await wait({ after })).toMatchObject({ ok: true, value: { status: 'cursor_expired' } })
  expect(await execute('observations.wait', { waitId: 'other', target: { kind: 'agent', sessionId: 'exact', owner }, after }, { kind: 'external', id: 'other' })).toMatchObject({ ok: true, value: { status: 'cursor_expired' } })
})
it('returns the recorded lifecycle result for settled operations and never treats not_found as completion', async () => {
  vi.useFakeTimers()
  const read = vi.fn().mockResolvedValue({ ok: true, value: { status: 'not_found' } })
  const { wait } = setup(read)
  const request = { target: { kind: 'operation', callId: 'original-call' }, until: 'settled' }
  const missing = wait(request)
  await vi.advanceTimersByTimeAsync(500)
  expect(await missing).toMatchObject({ ok: true, value: { status: 'timeout' } })
  read.mockResolvedValue({ ok: true, value: { status: 'completed', result: { ok: true, value: { newSessionId: 'replacement' } } } })
  expect(await wait(request)).toMatchObject({ ok: true, value: { status: 'settled', snapshot: { value: { result: { value: { newSessionId: 'replacement' } } } } } })
})

// #875. `observations.wait` with `until: 'settled'` or `'attention'` on an
// AGENT always ran to its timeout, whatever the agent was doing — idle and
// input-ready, exited, or blocked on a permission. `until: 'change'` worked,
// which is why it went unnoticed.
//
// The consumer parsed the status with a HAND-WRITTEN copy of the producer's
// schema, and the two disagreed on the one field that decides both predicates:
// `exited` is `number | null` (agentReadOutput, control-sdk/catalog/
// conversation.ts), and the copy said `z.boolean()`. Every `safeParse` failed,
// so `agent.success` was false and neither predicate could ever be true.
//
// The fixtures below are built through the PRODUCER's schema on purpose. The
// old test hand-built `exited: false` — a value the producer cannot emit — so
// it agreed with the bug rather than with the app.
const agentStatus = (over: Partial<z.input<typeof agentStatusSchema>> = {}) =>
  agentStatusSchema.parse({
    process: 'running', activity: 'idle', transcript: 'ready', inputReady: true,
    exited: null, conditions: [], queuedCount: 0, draftPresent: false, ...over,
  })

const agentObservation = (over: Partial<z.input<typeof agentStatusSchema>> = {}): ControlResult => ({
  ok: true,
  value: { observedAt: Date.now(), sessionRunId: 'run-one', providerSessionId: 'native', status: agentStatus(over) },
  operation: { callId: String(Date.now()), instanceId: 'host', owner, status: 'completed' },
})

it('settles an agent that is idle, input-ready and unblocked (#875)', async () => {
  const { wait } = setup(vi.fn().mockResolvedValue(agentObservation()))
  expect(await wait({ until: 'settled' })).toMatchObject({ ok: true, value: { status: 'settled' } })
})

it.each([
  // A clean exit is code 0, which is FALSY — so "has it exited" cannot be a
  // truthiness test on the code. That is the whole bug, in one value.
  { what: 'a clean exit', over: { exited: 0 } },
  { what: 'a failed exit', over: { exited: 1 } },
  { what: 'a pending condition', over: { conditions: ['claude.permission-prompt'] } },
])('raises attention for $what (#875)', async ({ over }) => {
  const { wait } = setup(vi.fn().mockResolvedValue(agentObservation(over)))
  expect(await wait({ until: 'attention' })).toMatchObject({ ok: true, value: { status: 'attention' } })
})

it.each([
  { what: 'it has exited', over: { exited: 0 } },
  { what: 'input is not ready', over: { inputReady: false } },
  { what: 'it is still working', over: { activity: 'running' } },
  { what: 'a prompt is queued', over: { queuedCount: 1 } },
  { what: 'a condition is pending', over: { conditions: ['claude.permission-prompt'] } },
])('does NOT settle an agent when $what (#875)', async ({ over }) => {
  vi.useFakeTimers()
  const { wait } = setup(vi.fn().mockResolvedValue(agentObservation(over)))
  const result = wait({ until: 'settled' })
  await vi.advanceTimersByTimeAsync(500)
  expect(await result).toMatchObject({ ok: true, value: { status: 'timeout' } })
})

it('does not raise attention for a live, unblocked agent (#875)', async () => {
  vi.useFakeTimers()
  const { wait } = setup(vi.fn().mockResolvedValue(agentObservation({ activity: 'running' })))
  const result = wait({ until: 'attention' })
  await vi.advanceTimersByTimeAsync(500)
  expect(await result).toMatchObject({ ok: true, value: { status: 'timeout' } })
})

it('reports an unreadable agent status rather than silently never settling (#875)', async () => {
  // The failure mode that hid this for so long: a status the consumer cannot
  // parse looked exactly like an agent that is simply never ready. A schema
  // drift between producer and consumer must be loud.
  vi.useFakeTimers()
  const malformed: ControlResult = {
    ok: true,
    value: { observedAt: Date.now(), sessionRunId: 'run-one', providerSessionId: 'native', status: { process: 'running' } },
    operation: { callId: 'x', instanceId: 'host', owner, status: 'completed' },
  }
  const { wait } = setup(vi.fn().mockResolvedValue(malformed))
  const result = wait({ until: 'settled' })
  await vi.advanceTimersByTimeAsync(500)
  await expect(result).resolves.toMatchObject({ ok: false, error: { code: 'invalid_output' } })
})
