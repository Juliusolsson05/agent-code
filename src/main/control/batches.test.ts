import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { ControlError, defineCapability } from '@control-sdk'
import { createControlExecutor, createControlRegistry } from '../../control-sdk/host'
import { FileControlHistory } from './history/FileControlHistory'
import { batchControlCapabilities } from './batches'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
it('keeps independent cross-window receipts and never redelivers an uncertain child on partial retry or restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-batch-')); directories.push(directory)
  const history = new FileControlHistory(directory)
  const registry = createControlRegistry()
  const caller = { kind: 'external' as const, id: 'operator' }
  const owners = ['left', 'right'].map(windowId => ({ kind: 'window' as const, windowId, generation: 'current' }))
  const deliveries: string[] = []
  owners.forEach(owner => registry.register(owner, [defineCapability({ id: 'agents.prompt', title: 'Delivery boundary trial', execution: 'window', effect: 'mutation', completion: 'accepted', description: 'Fault injection at the provider delivery boundary, not a simulated agent conversation.',
    input: z.object({ sessionId: z.string(), prompt: z.string() }), output: z.object({ acceptance: z.string() }),
    handler: (input, context) => {
      expect(context.caller).toEqual(caller)
      deliveries.push(input.sessionId)
      if (input.sessionId === 'uncertain') throw new ControlError('failed', 'Lost acknowledgment after write', 'unknown')
      return { acceptance: 'transport' }
    },
  })]))
  const executor = () => createControlExecutor({ history, instanceId: randomUUID(), id: randomUUID, now: () => new Date().toISOString(), catalog: () => registry.list(),
    dispatch: (request, context) => registry.invoke(request, context) })
  let current = executor()
  registry.register({ kind: 'main', generation: 'main' }, batchControlCapabilities((request, identity) => current.invoke(request, identity)))
  const items = [{ itemKey: 'first', sessionId: 'accepted', prompt: 'first request', owner: owners[0] },
    { itemKey: 'second', sessionId: 'uncertain', prompt: 'second request', owner: owners[1] }]
  const run = (selected = items) => current.invoke({ capabilityId: 'agents.batchPrompt', input: { batchKey: 'trial', items: selected } }, caller)
  expect(await run()).toMatchObject({ ok: true, value: { succeeded: 1, failed: 1, items: [{ result: { ok: true } }, { result: { ok: false, error: { outcome: 'unknown' } } }] } })
  expect(deliveries).toEqual(['accepted', 'uncertain'])
  current = executor()
  // Reordered/subset retry has a new parent call but the same child intention.
  expect(await run([items[1]])).toMatchObject({ ok: true, value: { failed: 1, items: [{ result: { error: { outcome: 'unknown' }, operation: { reusedCallId: expect.any(String) } } }] } })
  expect(deliveries).toEqual(['accepted', 'uncertain'])
  expect(await run([{ ...items[0], prompt: 'different intention under old key' }])).toMatchObject({ ok: true, value: { failed: 1, items: [{ result: { error: { code: 'idempotency_conflict' } } }] } })
  expect(deliveries).toEqual(['accepted', 'uncertain'])
  const events = await history.events()
  expect(events.filter(event => event.capabilityId === 'agents.prompt' && event.kind === 'received').map(event => event.caller)).toEqual(['external:operator', 'external:operator'])
})
