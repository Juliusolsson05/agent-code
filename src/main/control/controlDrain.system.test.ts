import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createControlExecutor } from '@control-sdk/host'
import type { CapabilityListing, ControlRequest, ControlResult } from '@control-sdk'
import { FileControlHistory } from '@main/control/history/FileControlHistory'

// ---------------------------------------------------------------------------
// #943. Committed shutdown must close new effectful admission, settle what was
// already admitted, and await its durable result writes BEFORE the exit and
// the state-process lock are released.
//
// `createControlHost.dispose()` used to retire waits, window registrations and
// IPC handlers and return. None of that is evidence that anything stopped: an
// admitted operation was still running and its result was still queued behind
// `FileControlHistory`'s append tail. So the process could die between an
// effect HAPPENING and the record of it reaching disk — the one state that
// makes a retry after restart unanswerable, because nothing can say whether
// the mutation ran.
//
// Driven with the REAL executor and the REAL file history against a real
// directory, because the failure is about ordering between an in-flight
// dispatch and a file that is actually written. Only the dispatch target is a
// stand-in: there is no renderer here, and a controllable effect is the whole
// point.
// ---------------------------------------------------------------------------

let directory: string
let history: FileControlHistory
let ids = 0

/** Resolve/reject an effect from the test, so shutdown can start mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const owner = { kind: 'main' as const, generation: 'gen-1' }
const catalog = (): CapabilityListing[] => ([
  { owner, descriptor: { id: 'demo.mutate', title: 'Mutate', description: 'Mutate', execution: 'main', effect: 'mutation', completion: 'completed' } },
  { owner, descriptor: { id: 'demo.read', title: 'Read', description: 'Read', execution: 'main', effect: 'read', completion: 'completed' } },
] as CapabilityListing[])

function harness(dispatch: (request: ControlRequest) => Promise<ControlResult>) {
  return createControlExecutor({
    history,
    instanceId: 'instance-1',
    id: () => `call-${++ids}`,
    now: () => new Date(2026, 8, 20).toISOString(),
    catalog,
    dispatch: async request => await dispatch(request),
  })
}

const caller = { kind: 'external' as const, id: 'tester' }
const mutate = (requestKey?: string): ControlRequest => ({
  capabilityId: 'demo.mutate', input: {}, ...(requestKey ? { requestKey } : {}),
} as ControlRequest)

/** Every durable event kind recorded for a call, in file order. */
async function recorded(callId: string): Promise<string[]> {
  const text = await readFile(join(directory, 'events.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { callId: string; kind: string })
    .filter(event => event.callId === callId)
    .map(event => event.kind)
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'control-drain-'))
  history = new FileControlHistory(directory)
  ids = 0
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('committed shutdown drains what it admitted (#943)', () => {
  it('waits for a dispatched effect AND its durable result', async () => {
    // The composed case: shutdown begins while the effect is still running.
    const effect = deferred<ControlResult>()
    const executor = harness(async () => await effect.promise)
    const call = executor.invoke(mutate(), caller)
    await Promise.resolve()

    executor.closeAdmission()
    let drained = false
    const settle = executor.settled().then(() => { drained = true })

    // Nothing may be reported as settled while the effect is outstanding.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(drained).toBe(false)

    effect.resolve({ ok: true, value: 'done' } as ControlResult)
    await settle
    await history.drain()

    expect(drained).toBe(true)
    await call
    // Intent AND result on disk, in that order. Releasing the lock after only
    // the intent is what leaves a restart unable to answer for the effect.
    expect(await recorded('call-1')).toEqual(['received', 'dispatched', 'result'])
  })

  it('still records a result whose write is SLOW', async () => {
    // The append tail, not the caller's own promise, is what has to be
    // awaited: later appends chain behind earlier ones, so a caller holding
    // its result is no evidence the file is quiet.
    const executor = harness(async () => ({ ok: true, value: 1 } as ControlResult))
    const first = executor.invoke(mutate(), caller)
    const second = executor.invoke(mutate(), caller)
    executor.closeAdmission()
    await executor.settled()
    await history.drain()
    await Promise.all([first, second])

    expect(await recorded('call-1')).toContain('result')
    expect(await recorded('call-2')).toContain('result')
  })
})

describe('no new effect enters once admission is closed', () => {
  it('refuses a fresh mutation with a structured, not-started failure', async () => {
    let dispatched = 0
    const executor = harness(async () => { dispatched += 1; return { ok: true } as ControlResult })
    executor.closeAdmission()

    const result = await executor.invoke(mutate(), caller)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    // `not_started` is the load-bearing part: it tells a client the mutation
    // definitely did not happen, which is what makes a retry safe.
    expect(result.error.outcome).toBe('not_started')
    expect(result.operation?.status).toBe('blocked')
    expect(dispatched).toBe(0)
    // And it left no intent behind, so nothing is dangling in the journal.
    expect(await recorded('call-1')).toEqual([])
  })

  it('refuses an UNKNOWN capability too, rather than waving it through', async () => {
    // The gate reads the declared effect from the catalog. An id that is not
    // there has no declared effect, and assuming 'read' would admit exactly
    // the calls nothing knows anything about.
    const executor = harness(async () => ({ ok: true } as ControlResult))
    executor.closeAdmission()
    let dispatched = 0
    const executor2 = harness(async () => { dispatched += 1; return { ok: true } as ControlResult })
    executor2.closeAdmission()
    const result = await executor2.invoke({ capabilityId: 'demo.unknown', input: {} } as ControlRequest, caller)
    expect(result.ok).toBe(false)
    // Refused AT THE GATE, not admitted and then failed downstream: no
    // dispatch, and no durable intent left dangling in the journal. Treating
    // an unknown id as a read would admit exactly the calls nothing knows
    // anything about, and this is what tells the two apart.
    expect(dispatched).toBe(0)
    expect(result.operation?.status).toBe('blocked')
    expect(await readFile(join(directory, 'events.jsonl'), 'utf8').catch(() => '')).toBe('')
  })

  it('keeps answering READS, so a stuck quit can still be inspected', async () => {
    const executor = harness(async () => ({ ok: true, value: 'state' } as ControlResult))
    executor.closeAdmission()
    const result = await executor.invoke({ capabilityId: 'demo.read', input: {} } as ControlRequest, caller)
    expect(result.ok).toBe(true)
  })

  it('lets a NESTED call through, because its parent was already admitted', async () => {
    // Batch members, a wait's inner read, and the main process recording its
    // own operation receipt all arrive here after their parent was admitted.
    // Refusing them half-finishes work that is already underway — and the
    // internal completion receipts are how the drain reports itself.
    const executor = harness(async () => ({ ok: true, value: 'child' } as ControlResult))
    executor.closeAdmission()
    const result = await executor.invoke(mutate(), { kind: 'application', id: 'control-main:gen-1' }, { nested: true })
    expect(result.ok).toBe(true)
    expect(await recorded('call-1')).toContain('result')
  })
})

describe('a timed-out transport does not authorize repeating a mutation', () => {
  it('joins the in-flight call instead of dispatching twice', async () => {
    // A client that gave up waiting and retried with the same request key
    // must get the FIRST call's outcome. Dispatching again would run the
    // mutation twice, which is the failure the durable request key exists to
    // prevent — and shutdown must not change that.
    const effect = deferred<ControlResult>()
    let dispatched = 0
    const executor = harness(async () => { dispatched += 1; return await effect.promise })

    const first = executor.invoke(mutate('key-1'), caller)
    await new Promise(resolve => setTimeout(resolve, 10))
    const retry = executor.invoke(mutate('key-1'), caller)

    effect.resolve({ ok: true, value: 'once' } as ControlResult)
    const [a, b] = await Promise.all([first, retry])
    expect(dispatched).toBe(1)
    expect(a.ok && a.value).toBe('once')
    expect(b.ok && b.value).toBe('once')

    // And the drain does not report settled until BOTH have finished.
    executor.closeAdmission()
    await executor.settled()
    await history.drain()
    expect(await recorded('call-1')).toContain('result')
  })

  it('counts a retry that is still inside admission as outstanding', async () => {
    // `active` is only populated AFTER the serialized intent append, so a
    // drain built on that map alone would miss every call still inside
    // admission — which is where the serialized, slow part is.
    const effect = deferred<ControlResult>()
    const executor = harness(async () => await effect.promise)
    const call = executor.invoke(mutate(), caller)

    executor.closeAdmission()
    let drained = false
    void executor.settled().then(() => { drained = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(drained).toBe(false)

    effect.resolve({ ok: true } as ControlResult)
    await call
    await executor.settled()
    expect(drained).toBe(true)
  })
})


describe('the history tail is drained, not just the executor', () => {
  it('writes an append that was still queued when shutdown began', async () => {
    // `executor.settled()` cannot cover this. `recordTransport` appends
    // straight to the history — it is not an executor call — so an MCP
    // transport record issued just before quit is chained on the tail with
    // nothing awaiting it. Exiting there loses the only evidence of what
    // crossed the boundary.
    const pending = history.append({
      callId: 'transport-1', instanceId: 'instance-1', capabilityId: 'mcp.tools/call',
      caller: 'external:tester', at: new Date(2026, 8, 20).toISOString(), kind: 'transport',
    })
    // Not on disk yet: `append` has to load, open and write first.
    expect(await readFile(join(directory, 'events.jsonl'), 'utf8').catch(() => '')).toBe('')

    await history.drain()
    expect(await recorded('transport-1')).toEqual(['transport'])
    await pending
  })

  it('survives a poisoned tail instead of blocking the exit', async () => {
    // The tail absorbs rejections into `poisoned`, and the caller that issued
    // the failing append already has its own error. Re-throwing here would
    // turn one caller's failed write into an application that cannot quit.
    await rm(directory, { recursive: true, force: true })
    const broken = new FileControlHistory(join(directory, 'events.jsonl', 'nested'))
    await broken.append({
      callId: 'x', instanceId: 'i', capabilityId: 'demo.mutate',
      caller: 'external:tester', at: new Date(2026, 8, 20).toISOString(), kind: 'received',
    }).catch(() => undefined)
    await expect(broken.drain()).resolves.toBeUndefined()
  })
})
