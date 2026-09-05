import { mkdtemp, readFile, appendFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createControlExecutor, createControlRegistry } from '../../../control-sdk/host'
import { defineCapability, type ControlHistory, type ControlResult } from '@control-sdk'
import { FileControlHistory } from './FileControlHistory'
import { historyCapabilities } from './control'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ac-control-history-'))
  directories.push(directory)
  return { directory, history: new FileControlHistory(directory) }
}
const caller = { kind: 'external' as const, id: 'trial-client' }
function executor(history: ControlHistory, handler: () => Promise<unknown> = async () => 'done') {
  const registry = createControlRegistry()
  registry.register({ kind: 'main', generation: 'trial' }, [defineCapability({
    id: 'trial.act', title: 'Harmless trial', description: 'Exercise durable admission',
    execution: 'main', effect: 'mutation', input: z.object({ text: z.string() }), output: z.unknown(), handler,
  }), ...historyCapabilities(history)])
  return createControlExecutor({ history, instanceId: randomUUID(), id: randomUUID, now: () => new Date().toISOString(),
    catalog: () => registry.list(), dispatch: (request, context) => registry.invoke(request, context) })
}
const request = { capabilityId: 'trial.act', input: { text: 'first prompt' }, requestKey: 'one-intention' }

describe('durable control execution (real temporary files, injected contract faults)', () => {
  it('records concurrent retries, dispatches once, and reuses the result after reopen', async () => {
    const { directory, history } = await setup()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let effects = 0
    const run = executor(history, async () => { effects++; entered(); await gate; return 'sent' })
    const first = run.invoke(request, caller)
    await started
    const retry = run.invoke(request, caller)
    release()
    const [a, b] = await Promise.all([first, retry])
    expect(effects).toBe(1)
    expect(b.operation?.reusedCallId).toBe(a.operation?.callId)
    const reopened = executor(new FileControlHistory(directory), async () => { effects++; return 'should not run' })
    const replay = await reopened.invoke(request, caller)
    expect(replay).toMatchObject({ ok: true, value: 'sent', operation: { reusedCallId: a.operation?.callId } })
    expect(await reopened.invoke({ ...request, input: { text: 'different prompt' } }, caller)).toMatchObject({
      ok: false, error: { code: 'idempotency_conflict', outcome: 'not_started' },
    })
    expect(effects).toBe(1)
    const events = await new FileControlHistory(directory).events()
    expect(events.filter(event => event.kind === 'dispatched')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'duplicate')).toHaveLength(3)
    expect(new Set(events.map(event => event.callId)).size).toBe(4)
    expect((await stat(join(directory, 'events.jsonl'))).mode & 0o777).toBe(0o600)
  })

  it('preserves uncertainty after losing the final write and never retries the effect on restart', async () => {
    const { directory, history } = await setup()
    const failing: ControlHistory = {
      append: (event, payload) => event.kind === 'result' ? Promise.reject(new Error('injected disk failure')) : history.append(event, payload),
      events: () => history.events(), payload: id => history.payload(id), chunk: (id, offset, limit) => history.chunk(id, offset, limit),
    }
    const result = await executor(failing).invoke(request, caller)
    expect(result).toMatchObject({ ok: true, operation: { historyWarning: expect.any(String) } })
    let effects = 0
    const replay = await executor(new FileControlHistory(directory), async () => { effects++; return 'bad' }).invoke(request, caller)
    expect(replay).toMatchObject({ ok: false, error: { code: 'interrupted', outcome: 'unknown' } })
    expect(effects).toBe(0)
  })

  it('blocks effects before an unrecorded intent and preserves a damaged tail byte for byte', async () => {
    const { directory, history } = await setup()
    await executor(history).invoke(request, caller)
    const path = join(directory, 'events.jsonl')
    await appendFile(path, '{"sequence":4,"kind":"dispat')
    const before = await readFile(path)
    let effects = 0
    expect(await executor(new FileControlHistory(directory), async () => { effects++; return 'bad' })
      .invoke({ ...request, requestKey: 'different' }, caller)).toMatchObject({
      ok: false, error: { code: 'history_unavailable', outcome: 'not_started' },
    })
    expect(effects).toBe(0)
    expect(await readFile(path)).toEqual(before)
  })

  it('retrieves a complete large Unicode payload and freezes history paging before its own reads', async () => {
    const { history } = await setup()
    const full = 'agent output 🦊 漢字\n'.repeat(20000)
    const run = executor(history, async () => full)
    const result = await run.invoke(request, caller)
    const records = await history.events()
    const id = records.find(event => event.kind === 'result')!.payload!
    let offset = 0
    let reconstructed = ''
    do {
      const chunk = await history.chunk(id, offset, 4096)
      reconstructed += chunk.text
      if (chunk.nextOffset === null) break
      expect(chunk.nextOffset).toBeGreaterThan(offset)
      offset = chunk.nextOffset
    } while (true)
    expect(JSON.parse(reconstructed)).toEqual(result)
    const first = await run.invoke({ capabilityId: 'history.list', input: { limit: 1 } }, caller) as ControlResult<{
      events: Array<{ sequence: number }>; snapshot: number; nextAfter: number | null
    }>
    if (!first.ok) throw new Error('History read failed')
    expect(first.value.snapshot).toBe(records.length)
    let after = first.value.nextAfter
    const collected = [...first.value.events]
    while (after !== null) {
      const page = await run.invoke({ capabilityId: 'history.list', input: { limit: 1, after, snapshot: first.value.snapshot } }, caller) as typeof first
      if (!page.ok) throw new Error('History page failed')
      collected.push(...page.value.events)
      after = page.value.nextAfter
    }
    expect(collected.map(event => event.sequence)).toEqual(records.map(event => event.sequence))
  })
})
