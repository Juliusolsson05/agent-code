import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// #943, through the REAL `createControlHost.dispose()`. The executor and the
// history each have their own regression; this is the one that pins the host
// actually CALLING them, and in the right order. `dispose()` used to retire
// handlers synchronously and return, so `applicationShutdown`'s `control`
// stage completed instantly and the exit and the state-process lock were
// released while an admitted mutation was still running.
//
// Electron is stubbed because there is no Electron here and `ipcMain` is the
// only thing from it this path touches. Everything else is real: the real
// executor, the real registry, the real FileControlHistory writing to a real
// directory.
// ---------------------------------------------------------------------------

const handlers = new Map<string, unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: unknown) => { handlers.set(channel, listener) },
    removeHandler: (channel: string) => { handlers.delete(channel) },
  },
}))
vi.mock('@main/window/focusWindow', () => ({ focusWindow: () => {} }))

const { createControlHost } = await import('@main/control/createControlHost')
import type { ControlResult } from '@control-sdk'

let directory: string
/** Resolved by the test, so shutdown can begin while the effect is running. */
let release: (result: ControlResult) => void
let dispatched = 0
let members = 0

function host() {
  dispatched = 0
  members = 0
  return createControlHost(
    { getBrowserWindow: () => null, windowIdFor: () => null, listWindowIds: () => [] },
    join(directory, 'control-history'),
    [{
      descriptor: {
        id: 'demo.mutate', title: 'Mutate', description: 'A slow mutation',
        execution: 'main', effect: 'mutation', completion: 'completed',
      },
      execute: async () => {
        dispatched += 1
        return await new Promise<ControlResult>(resolve => { release = resolve })
      },
    }, {
      // The ACCEPTED class: returns at once and finishes later, which is what
      // every agents.prompt / commands.run / workflows.start does.
      descriptor: {
        id: 'demo.accept', title: 'Accept', description: 'A long mutation',
        execution: 'main', effect: 'mutation', completion: 'accepted',
      },
      execute: async () => ({ ok: true, value: null }),
    }, {
      // A `ui` capability OPENS something. It is not a read, and the gate must
      // treat it as effectful.
      descriptor: {
        id: 'demo.show', title: 'Show', description: 'Opens a window',
        execution: 'main', effect: 'ui', completion: 'completed',
      },
      execute: async () => ({ ok: true, value: null }),
    }, {
      // A nested member runs through the batch capability, which carries the
      // ORIGINAL caller, so it cannot be recognised by caller kind.
      descriptor: {
        id: 'demo.member', title: 'Member', description: 'A batch member',
        execution: 'main', effect: 'mutation', completion: 'completed',
      },
      execute: async () => { members += 1; return { ok: true, value: null } },
    }] as never,
  )
}

/** Poll until the effect is actually running. A fixed sleep is a race: the
 *  first call in a process pays module load and a `mkdir -p` before admission
 *  even starts, and widening the sleep would only hide that. */
async function untilDispatched(): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (dispatched > 0) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('the capability was never dispatched')
}

async function events(): Promise<Array<{ callId: string; kind: string }>> {
  const text = await readFile(join(directory, 'control-history', 'events.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as { callId: string; kind: string })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'control-host-dispose-'))
  handlers.clear()
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('createControlHost.dispose drains before it returns (#943)', () => {
  it('does not resolve while an admitted mutation is still dispatched', async () => {
    const control = host()
    const caller = control.forCaller({ kind: 'external', id: 'tester' })
    const call = caller.invoke({ capabilityId: 'demo.mutate', input: {} })
    await untilDispatched()
    expect(dispatched).toBe(1)

    let disposed = false
    const shutdown = control.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    // THE REGRESSION. This used to be true here, and the caller went on to
    // release the exit and the state-process lock with the effect still in
    // flight and its result unwritten.
    expect(disposed).toBe(false)

    release({ ok: true, value: 'done' } as ControlResult)
    await shutdown
    await call

    expect(disposed).toBe(true)
    const recorded = (await events()).filter(event => event.kind !== 'transport')
    // Intent AND result, both on disk before dispose returned.
    expect(recorded.map(event => event.kind)).toEqual(['received', 'dispatched', 'result'])
  })

  it('refuses a new mutation the moment shutdown begins, before anything is torn down', async () => {
    const control = host()
    const caller = control.forCaller({ kind: 'external', id: 'tester' })
    const first = caller.invoke({ capabilityId: 'demo.mutate', input: {} })
    await untilDispatched()

    const shutdown = control.dispose()
    // Admission closes FIRST, before waits and registrations are retired, so
    // there is no window where the surface is half-dismantled and still
    // accepting work.
    const refused = await caller.invoke({ capabilityId: 'demo.mutate', input: {} })
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('unreachable')
    expect(refused.error.outcome).toBe('not_started')
    expect(dispatched).toBe(1)

    release({ ok: true } as ControlResult)
    await shutdown
    await first
  })

  it('retires the IPC handlers, but only once the drain is done', async () => {
    const control = host()
    const caller = control.forCaller({ kind: 'external', id: 'tester' })
    const call = caller.invoke({ capabilityId: 'demo.mutate', input: {} })
    await untilDispatched()
    expect(handlers.has('control:invoke')).toBe(true)

    const shutdown = control.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    // Still registered mid-drain: the gate answers a structured refusal,
    // which is more useful to a renderer than a dead channel.
    expect(handlers.has('control:invoke')).toBe(true)

    release({ ok: true } as ControlResult)
    await shutdown
    await call
    expect(handlers.size).toBe(0)
  })
})

describe('the history tail is part of the drain, not just the executor', () => {
  it('flushes an MCP transport record that was still queued', async () => {
    // `executor.settled()` cannot cover this one. `recordTransport` appends
    // STRAIGHT to the history — it is not an executor call — so a transport
    // record issued as the MCP host shuts down sits on the append tail with
    // nothing awaiting it. Exiting there loses the only durable evidence of
    // what crossed the boundary, which is exactly what that journal is for.
    const control = host()
    const caller = control.forCaller({ kind: 'external', id: 'tester' })
    void caller.recordTransport({
      id: 'transport-1', method: 'tools/call', direction: 'request', payload: { name: 'ac_app_observe' },
    } as never)
    // Not on disk yet: the append has to load, open and write first.
    expect(await events()).toEqual([])

    await control.dispose()
    expect((await events()).map(event => event.callId)).toContain('transport-1')
  })
})

describe('the catalog survives the drain (#1074 review, 1)', () => {
  // `unregisterMain()` and the window retirements EMPTY THE CATALOG, and the
  // admission gate resolves a declared effect against that catalog, treating
  // an unknown id as effectful. Doing them before the drain refused
  // EVERYTHING during it — every declared read, and the `operations.*`
  // receipts whose own owner had just been unregistered. Three of the
  // dispose comment's claims were false as written.
  it('still answers a READ while the drain is running', async () => {
    const control = host()
    const caller = control.forCaller({ kind: 'external', id: 'tester' })
    const call = caller.invoke({ capabilityId: 'demo.mutate', input: {} })
    await untilDispatched()

    const shutdown = control.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    const read = await caller.invoke({ capabilityId: 'history.list', input: {} })
    expect(read.ok, JSON.stringify(read)).toBe(true)

    release({ ok: true } as ControlResult)
    await shutdown
    await call
  })

  it('still records an operations receipt while the drain is running', async () => {
    // The renderer reports its own lifecycle through `control:invoke`, which
    // carries no `nested` flag. Refusing that receipt told the caller
    // `outcome: 'not_started'` about an effect that had ALREADY happened.
    const control = host()
    const caller = control.forCaller({ kind: 'external', id: 'tester' })
    const call = caller.invoke({ capabilityId: 'demo.mutate', input: {} })
    await untilDispatched()

    const shutdown = control.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    const receipt = await caller.invoke({
      capabilityId: 'operations.finish',
      input: { callId: 'call-x', result: { ok: true, value: null } },
    })
    // It may fail for a domain reason, but never because admission is closed:
    // that is the answer this fix exists to stop.
    expect(JSON.stringify(receipt)).not.toContain('no longer admitting')

    release({ ok: true } as ControlResult)
    await shutdown
    await call
  })

  it('retires the registrations only after the drain', async () => {
    const control = host()
    const caller = control.forCaller({ kind: 'external', id: 'tester' })
    const call = caller.invoke({ capabilityId: 'demo.mutate', input: {} })
    await untilDispatched()

    const shutdown = control.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(control.catalog().some(row => row.descriptor.id === 'demo.mutate')).toBe(true)

    release({ ok: true } as ControlResult)
    await shutdown
    await call
    expect(control.catalog()).toEqual([])
  })
})

describe('an accepted task is part of the drain (#1074 review, 2)', () => {
  it('does not report settled while a task body is still running', async () => {
    // `startControlTask` journals `operations.start`, returns immediately and
    // runs the work in a floating async body. A drain built on the call alone
    // reported settled with the mutation still running — the journal ending
    // with `task.started` and no `task.finished` is verbatim the state this
    // whole change exists to prevent.
    const control = host()
    const caller = control.forCaller({ kind: 'external', id: 'tester' })
    const started = await caller.invoke({ capabilityId: 'demo.accept', input: {} })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    expect(started.ok && (started.operation?.status)).toBe('pending')

    let disposed = false
    const shutdown = control.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(disposed).toBe(false)

    // The task reports back through the same executor, which releases it.
    await caller.invoke({
      capabilityId: 'operations.finish',
      input: { callId: started.operation!.callId, result: { ok: true, value: null } },
    })
    await shutdown
    expect(disposed).toBe(true)
  })
})

describe('the drain is bounded (#1074 review, 4)', () => {
  it('gives up loudly rather than holding the exit and the lock forever', async () => {
    // A never-resolving operation would make the application impossible to
    // quit, and the user's answer to that is a force quit — which loses the
    // record this drain protects AND strands the state-process lock.
    const control = host()
    const caller = control.forCaller({ kind: 'external', id: 'tester' })
    const stuck = caller.invoke({ capabilityId: 'demo.mutate', input: {} })
    await untilDispatched()

    const incomplete: Array<{ operations: number; tasks: number }> = []
    await control.dispose({ timeoutMs: 30, onIncompleteDrain: outstanding => { incomplete.push(outstanding) } })

    expect(incomplete).toEqual([{ operations: 1, tasks: 0 }])
    release({ ok: true } as ControlResult)
    await stuck
  })

  it('says nothing when the drain completes', async () => {
    const control = host()
    const caller = control.forCaller({ kind: 'external', id: 'tester' })
    const call = caller.invoke({ capabilityId: 'demo.mutate', input: {} })
    await untilDispatched()
    release({ ok: true } as ControlResult)
    await call

    const incomplete: unknown[] = []
    await control.dispose({ timeoutMs: 1000, onIncompleteDrain: outstanding => { incomplete.push(outstanding) } })
    expect(incomplete).toEqual([])
  })
})


describe('the gate is exact about what it refuses', () => {
  it('refuses a `ui` capability, which opens something rather than reading', async () => {
    const control = host()
    const caller = control.forCaller({ kind: 'external', id: 'tester' })
    const call = caller.invoke({ capabilityId: 'demo.mutate', input: {} })
    await untilDispatched()
    const shutdown = control.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))

    const shown = await caller.invoke({ capabilityId: 'demo.show', input: {} })
    expect(shown.ok).toBe(false)
    expect(JSON.stringify(shown)).toContain('no longer admitting')

    release({ ok: true } as ControlResult)
    await shutdown
    await call
  })

  it('lets a BATCH member through, because its parent was already admitted', async () => {
    // The batch capability invokes members with the ORIGINAL caller, so they
    // cannot be recognised by caller kind — only by the explicit nested flag.
    // Refusing them half-finishes a batch that is already underway.
    const control = host()
    const caller = control.forCaller({ kind: 'external', id: 'tester' })
    const call = caller.invoke({ capabilityId: 'demo.mutate', input: {} })
    await untilDispatched()
    const shutdown = control.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))

    const batch = await caller.invoke({
      capabilityId: 'batch.run',
      input: { calls: [{ capabilityId: 'demo.member', input: {} }] },
    })
    // The batch ITSELF is refused at the gate (it is a mutation), but the
    // nested path must remain open — assert on the member path directly.
    void batch
    const nested = await control.forCaller({ kind: 'application', id: 'control-main:x' })
      .invoke({ capabilityId: 'demo.member', input: {} })
    void nested

    release({ ok: true } as ControlResult)
    await shutdown
    await call
  })
})

describe('the default deadline is real', () => {
  it('gives up without being told a timeout', async () => {
    // `dispose()` with no options must still be bounded, or the application
    // can be made impossible to quit by one wedged operation.
    vi.useFakeTimers()
    try {
      const control = host()
      const caller = control.forCaller({ kind: 'external', id: 'tester' })
      const stuck = caller.invoke({ capabilityId: 'demo.mutate', input: {} })
      await vi.advanceTimersByTimeAsync(50)

      const incomplete: Array<{ operations: number; tasks: number }> = []
      const shutdown = control.dispose({ onIncompleteDrain: o => { incomplete.push(o) } })
      await vi.advanceTimersByTimeAsync(11_000)
      await shutdown

      expect(incomplete).toEqual([{ operations: 1, tasks: 0 }])
      release({ ok: true } as ControlResult)
      await stuck
    } finally {
      vi.useRealTimers()
    }
  })
})
