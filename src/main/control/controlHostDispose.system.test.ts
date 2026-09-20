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

function host() {
  dispatched = 0
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
