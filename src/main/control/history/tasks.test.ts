import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineCapability, type ControlContext, type ControlRequest } from '@control-sdk'
import { createControlExecutor, createControlRegistry } from '../../../control-sdk/host'
import { startControlTask } from '../../../control-sdk/task'
import { FileControlHistory } from './FileControlHistory'
import { taskHistoryCapabilities } from './tasks'

const directories: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it('records admission before work, persists final results and reports abandoned renderer work as unknown', async () => {
  const path = await mkdtemp(join(tmpdir(), 'ac-task-history-'))
  directories.push(path)
  const history = new FileControlHistory(path)
  const registry = createControlRegistry()
  const owner = { kind: 'window' as const, windowId: 'left', generation: 'original' }
  const main = { kind: 'main' as const, generation: 'main' }
  let live = true
  registry.register(main, taskHistoryCapabilities(history, candidate => live && JSON.stringify(candidate) === JSON.stringify(owner)))
  let finish!: (result: unknown) => void
  let effects = 0
  const gate = new Promise(resolve => { finish = resolve })
  registry.register(owner, [defineCapability({ id: 'trial.long', title: 'Deferred contract trial', execution: 'window', effect: 'mutation', completion: 'accepted',
    description: 'A controlled deferred result, not a simulated provider workload.', input: z.object({}), output: z.object({ callId: z.string(), accepted: z.literal(true) }),
    handler: (_input, context) => startControlTask(context, request => executor.invoke(request, { kind: 'application', id: 'left' }), async () => {
      const steps = await history.events()
      expect(steps.some(event => event.callId === context.requestId && event.kind === 'step')).toBe(true)
      effects++
      return gate
    }),
  })])
  const executor = createControlExecutor({ history, instanceId: 'trial', id: randomUUID, now: () => new Date().toISOString(), catalog: () => registry.list(),
    dispatch: (request, context) => registry.invoke(request, context) })
  vi.stubGlobal('window', { api: { controlInvoke: (request: ControlRequest) => executor.invoke(request, { kind: 'application', id: 'left' }) } })
  const call = await executor.invoke({ capabilityId: 'trial.long', input: {}, requestKey: 'one-operation' }, { kind: 'external', id: 'operator' })
  if (!call.ok) throw new Error(JSON.stringify(call))
  const callId = call.operation!.callId
  const read = () => executor.invoke({ capabilityId: 'operations.read', input: { callId } }, { kind: 'external', id: 'operator' })
  expect(await read()).toMatchObject({ ok: true, value: { status: 'pending' } })
  expect(await executor.invoke({ capabilityId: 'operations.finish', input: { callId, result: { ok: true, value: 'wrong owner' } } }, { kind: 'application', id: 'right' }))
    .toMatchObject({ ok: false, error: { code: 'stale_owner' } })
  live = false
  expect(await read()).toMatchObject({ ok: true, value: { status: 'outcome_unknown' } })
  live = true
  finish({ sourceSessionId: 'old', newSessionId: 'new' })
  await vi.waitFor(async () => { expect(await read()).toMatchObject({ ok: true, value: { status: 'completed', result: { ok: true, value: { newSessionId: 'new' } } } }) })
  const retry = await executor.invoke({ capabilityId: 'trial.long', input: {}, requestKey: 'one-operation' }, { kind: 'external', id: 'operator' })
  expect(retry.operation?.reusedCallId).toBe(callId)
  expect(effects).toBe(1)
  const reopened = taskHistoryCapabilities(new FileControlHistory(path), () => false)
  const context: ControlContext = { requestId: 'read-after-restart', owner: main, caller: { kind: 'external', id: 'operator' } }
  expect(await reopened.find(item => item.descriptor.id === 'operations.read')!.execute({ callId }, context))
    .toMatchObject({ ok: true, value: { status: 'completed', result: { ok: true, value: { newSessionId: 'new' } } } })
})
