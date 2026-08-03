import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SESSION_LIFECYCLE_AREA } from '@shared/lifecycle/events.js'

// One shared emitter stands in for ipcMain so the handler can be driven
// synchronously. `ipcMain.on` is the only surface this module uses.
const bus = new EventEmitter()
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      bus.on(channel, payload => listener({}, payload))
    },
  },
}))

type Recorded = { area: string; name: string; ids?: { sessionId?: string }; data?: Record<string, unknown> }

function send(payload: unknown): void {
  bus.emit('session:lifecycle-report', payload)
}

describe('registerLifecycleIpc', () => {
  let records: Recorded[]

  beforeEach(async () => {
    // Frozen clock so the token bucket is deterministic: with real time a
    // synchronous storm never refills, and the suppression summary — which only
    // emits once a token is available again — could never be observed.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-28T00:00:00Z'))
    bus.removeAllListeners()
    records = []
    const { registerLifecycleIpc } = await import('./lifecycle')
    registerLifecycleIpc({ record: (r: Recorded) => records.push(r) } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const lifecycle = (): Recorded[] => records.filter(r => r.area === SESSION_LIFECYCLE_AREA)

  it('accepts a known event name and forwards its session id', () => {
    send({ name: 'wake.request', sessionId: 's1', data: { caller: 'tile-leaf.send' } })

    expect(lifecycle()).toHaveLength(1)
    expect(lifecycle()[0]).toMatchObject({
      name: 'wake.request',
      ids: { sessionId: 's1' },
      data: { caller: 'tile-leaf.send' },
    })
  })

  it('drops an event name outside the closed vocabulary', () => {
    // A renderer from a different build must not be able to widen the
    // vocabulary at runtime — the closed set is what keeps the stream readable.
    send({ name: 'totally.made.up', sessionId: 's1' })
    send({ name: 'wake.request', sessionId: 's1' })

    expect(lifecycle().map(r => r.name)).toEqual(['wake.request'])
  })

  it('ignores malformed payloads without throwing', () => {
    // IPC is a runtime trust boundary and a renderer mid-freeze is exactly the
    // sender most likely to be malformed.
    expect(() => {
      send(null)
      send('a string')
      send(42)
      send({})
      send({ name: 123 })
    }).not.toThrow()
    expect(lifecycle()).toHaveLength(0)
  })

  it('strips payload keys outside the allowlist', () => {
    send({
      name: 'submit.result',
      sessionId: 's1',
      data: { ok: false, prompt: 'secret user text', stack: 'nope' },
    })

    expect(lifecycle()[0].data).toEqual({ ok: false })
  })

  it('rate-limits a storm and records the count of what it dropped', () => {
    // A remount loop or retry storm is precisely the pathological state this
    // instrumentation exists to observe. Unbounded, it would flood the journal
    // and evict the breadcrumbs explaining it.
    for (let i = 0; i < 500; i += 1) {
      send({ name: 'wake.request', sessionId: 's1', data: { caller: 'tile-leaf.send' } })
    }

    // Exactly BURST admitted while the clock is frozen; the other 200 dropped.
    expect(lifecycle()).toHaveLength(300)
    expect(lifecycle().every(r => r.name === 'wake.request')).toBe(true)

    // The drop must be RECORDED, not silent: a reader reconstructing a ladder
    // has to tell "this pane emitted nothing" from "this pane's events were
    // dropped". One second of refill admits the next report, which carries the
    // count of everything lost.
    vi.setSystemTime(new Date('2026-07-28T00:00:01Z'))
    send({ name: 'wake.request', sessionId: 's1' })

    const suppressed = lifecycle().filter(r => r.name === 'report.suppressed')
    expect(suppressed).toHaveLength(1)
    expect(suppressed[0].data).toMatchObject({ suppressed: 200, reason: 'rate-limited' })
  })

  it('truncates an unreasonably long session id rather than storing it whole', () => {
    send({ name: 'wake.request', sessionId: 'x'.repeat(5000) })

    expect((lifecycle()[0].ids?.sessionId ?? '').length).toBe(200)
  })
})
