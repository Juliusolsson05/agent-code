import { afterEach, expect, it, vi } from 'vitest'
import { createWaitControl } from './waits'
import type { ControlResult } from '@control-sdk'
const context = { requestId: 'read', caller: { kind: 'external' as const, id: 'operator' }, owner: { kind: 'main' as const, generation: 'main' } }
const owner = { kind: 'window' as const, windowId: 'second', generation: 'one' }
afterEach(() => vi.useRealTimers())
const observation = (activity = 'running', run = 'run-one'): ControlResult => ({ ok: true, value: { observedAt: Date.now(), sessionRunId: run, providerSessionId: 'native', status: { activity, exited: false, conditions: [], queuedCount: 0, inputReady: true } }, operation: { callId: String(Date.now()), instanceId: 'host', owner, status: 'completed' } })
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
