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
const observation = (activity: 'idle' | 'running' | 'exited' = 'running', run = 'run-one'): ControlResult => ({ ok: true, value: { observedAt: Date.now(), sessionRunId: run, providerSessionId: 'native', status: agentStatusSchema.parse({ process: 'started', activity, transcript: 'ready', inputReady: true, exited: null, conditions: [], queuedCount: 0, draftPresent: false }) }, operation: { callId: String(Date.now()), instanceId: 'host', owner, status: 'completed' } })
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
// `process: 'started'`, not `'running'` — `ProcessStatus` has no `running`
// (#1086 review, finding 5). The first version of this fixture hand-built one
// anyway, in a file whose own comment says a fixture must not carry a value
// the producer cannot emit; the schema's three string fields are closed enums
// now, so the type system says so instead of a comment.
const agentStatus = (over: Partial<z.input<typeof agentStatusSchema>> = {}) =>
  agentStatusSchema.parse({
    process: 'started', activity: 'idle', transcript: 'ready', inputReady: true,
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
  // #1086 review, finding 6. `exited: null` and no conditions, so BOTH
  // predicates were false and the wait ran its whole timeout — the same silent
  // never-ready this change exists to remove, for the state an operator most
  // needs to hear about: the agent it is waiting on is dead on arrival. It is
  // the ordinary "could not re-adopt the backend after a restart" path.
  { what: 'a backend that failed to start', over: { process: 'failed' as const, inputReady: false } },
])('raises attention for $what (#875)', async ({ over }) => {
  const { wait } = setup(vi.fn().mockResolvedValue(agentObservation(over)))
  expect(await wait({ until: 'attention' })).toMatchObject({ ok: true, value: { status: 'attention' } })
})

it.each([
  { what: 'it has exited', over: { exited: 0 } },
  { what: 'input is not ready', over: { inputReady: false } },
  { what: 'it is still working', over: { activity: 'running' as const } },
  { what: 'a prompt is queued', over: { queuedCount: 1 } },
  { what: 'a condition is pending', over: { conditions: ['claude.permission-prompt'] } },
  // A failed backend is never settled either: it will not become ready.
  { what: 'its backend failed to start', over: { process: 'failed' as const } },
  // #1086 review, mutation B. `activity === 'idle'` and `activity !==
  // 'running'` differ only for `'exited'`, and production cannot produce this
  // exact pair: `deriveSessionStatus` makes `activity === 'exited'` imply
  // `exited !== null`, so `hasExited` blocks it first. That coupling lives in
  // a different file and nothing here recorded it — this does, so the day the
  // invariant changes, this predicate does not quietly start settling a dead
  // agent.
  { what: 'it reports exited even with no exit code', over: { activity: 'exited' as const } },
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

it('leaves until:change working when the status cannot be parsed (#1086 review, finding 3)', async () => {
  // `change` only HASHES the status — it never needed it parsed, and it was
  // the one mode that always worked. Making the throw unconditional would have
  // turned it into one that can hard-fail, which is the single place this
  // change would not have been a strict improvement.
  vi.useFakeTimers()
  const malformed = (activity: string): ControlResult => ({
    ok: true,
    value: { observedAt: Date.now(), sessionRunId: 'run-one', providerSessionId: 'native', status: { process: 'running', activity } },
    operation: { callId: String(Date.now()), instanceId: 'host', owner, status: 'completed' },
  })
  const read = vi.fn().mockResolvedValue(malformed('running'))
  const { wait } = setup(read)
  const first = wait()
  await vi.advanceTimersByTimeAsync(500)
  const result = await first
  expect(result).toMatchObject({ ok: true, value: { status: 'timeout' } })
  if (!result.ok) throw new Error('wait failed')
  read.mockResolvedValue(malformed('idle'))
  expect(await wait({ after: (result.value as { cursor: string }).cursor })).toMatchObject({ ok: true, value: { status: 'changed' } })
})

it('names the field it could not read (#1086 review, finding 4)', async () => {
  // A branch whose entire purpose is diagnosis must not throw the diagnosis
  // away. The zod issues ride on `details`, which `controlResultSchema`
  // already carries.
  vi.useFakeTimers()
  const malformed: ControlResult = {
    ok: true,
    value: { observedAt: Date.now(), sessionRunId: 'run-one', providerSessionId: 'native', status: { process: 'started', activity: 'idle', transcript: 'ready', inputReady: true, exited: false, conditions: [], queuedCount: 0, draftPresent: false } },
    operation: { callId: 'x', instanceId: 'host', owner, status: 'completed' },
  }
  const { wait } = setup(vi.fn().mockResolvedValue(malformed))
  const result = wait({ until: 'settled' })
  await vi.advanceTimersByTimeAsync(500)
  const settled = await result
  expect(settled).toMatchObject({ ok: false, error: { code: 'invalid_output' } })
  if (settled.ok) throw new Error('expected a failure')
  // `exited: false` is the EXACT historical mis-shape. A schema that admitted
  // a boolean would parse it and read it as "has exited".
  expect(JSON.stringify(settled.error.details)).toContain('exited')
})

it('publishes every status field it promises (#1086 review, finding 8)', () => {
  // One schema now feeds both the wait predicate and `ac_agents_read`'s
  // published payload AND its advertised JSON Schema, so deleting one word
  // from it silently strips a field from the MCP contract. That edit was
  // invisible to 1308 tests.
  expect(Object.keys(agentStatusSchema.shape).sort()).toEqual([
    'activity', 'conditions', 'draftPresent', 'exited', 'inputReady', 'process', 'queuedCount', 'transcript',
  ])
})
