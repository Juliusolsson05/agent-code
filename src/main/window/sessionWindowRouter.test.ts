import type { SessionRoutingGap } from '@shared/types/sessionRouting.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionWindowRouter } from './sessionWindowRouter.js'
import type {
  RoutingDeliveryResult, RoutingWindow, SessionWindowLease, SessionWindowRouterOptions,
} from './sessionWindowRouter.js'

type Delivery = { windowId: string; channel: string; args: unknown[] }
const routers: SessionWindowRouter[] = []

function harness(limits?: SessionWindowRouterOptions['limits']) {
  const windows = new Map<string, RoutingWindow>([
    ['left', { generation: 1, accepting: true }], ['right', { generation: 1, accepting: true }],
  ])
  const deliveries: Delivery[] = []
  const gaps: Array<{ windowId: string; gap: SessionRoutingGap }> = []
  const incident = vi.fn()
  const deliver = vi.fn((lease: SessionWindowLease, channel: string, args: unknown[]): RoutingDeliveryResult => {
    deliveries.push({ windowId: lease.windowId, channel, args })
    return 'sent'
  })
  const router = new SessionWindowRouter({
    window: id => windows.get(id) ?? null, deliver, incident, limits,
    gap: (lease, gap) => { gaps.push({ windowId: lease.windowId, gap }); return true },
  })
  routers.push(router)
  return { router, windows, deliveries, gaps, incident, deliver }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
})
afterEach(() => {
  for (const router of routers.splice(0)) router.dispose()
  vi.useRealTimers()
})

describe('session display ownership and bounded transition delivery', () => {
  it('quarantines pre-claim content and requests repair only from the eventual explicit owner', () => {
    const h = harness()
    expect(h.router.send('pane', 'session:screen', [{ plain: 'private before ownership' }])).toBe('quarantined')
    expect(h.deliveries).toEqual([])
    expect(h.gaps).toEqual([])
    expect(JSON.stringify(h.router.diagnostics())).not.toContain('private')
    expect(JSON.stringify(h.incident.mock.calls)).not.toContain('private')
    h.router.claim('pane', 'right')
    expect(h.gaps).toHaveLength(1)
    expect(h.gaps[0]).toMatchObject({ windowId: 'right', gap: { sessionId: 'pane', reason: 'unowned', missedEvents: 1 } })
    expect(h.router.send('pane', 'session:screen', [{ plain: 'current' }])).toBe('delivered')
    expect(h.deliveries).toEqual([{ windowId: 'right', channel: 'session:screen', args: [{ plain: 'current' }] }])
  })

  it('holds the final event sequence during close and restores it in order after a veto', () => {
    const h = harness()
    h.router.claim('pane', 'left')
    h.windows.get('left')!.accepting = false
    const channels = ['session:semantic-event', 'session:jsonl-entries', 'session:exit']
    for (const channel of channels) expect(h.router.send('pane', channel, [{ sessionId: 'pane' }])).toBe('held')
    expect(h.deliveries).toEqual([])
    h.windows.get('left')!.accepting = true
    h.router.windowAvailable('left')
    expect(h.deliveries.map(d => d.channel)).toEqual(channels)
    expect(h.deliveries.every(d => d.windowId === 'left')).toBe(true)
    expect(h.router.diagnostics()).toMatchObject({ pendingEvents: 0, pendingBytes: 0 })
  })

  it('retargets a known held lifetime through an explicit transfer and fences an old release', () => {
    const h = harness()
    const first = h.router.claim('pane', 'left')!
    h.windows.delete('left')
    h.router.send('pane', 'session:jsonl-entries', [{ entries: ['last committed record'] }])
    const next = h.router.transfer('pane', 'right')!
    expect(h.router.release(first)).toBe(false)
    expect(h.router.owner('pane')).toBe(next)
    expect(h.deliveries).toEqual([{ windowId: 'right', channel: 'session:jsonl-entries', args: [{ entries: ['last committed record'] }] }])
  })

  it('does not replay a predecessor queue into a fresh claim under the same session id', () => {
    const h = harness()
    const first = h.router.claim('pane', 'left')!
    h.windows.get('left')!.accepting = false
    h.router.send('pane', 'session:semantic-event', [{ textSoFar: 'old run' }])
    h.windows.get('left')!.accepting = true
    const next = h.router.claim('pane', 'left')!
    expect(h.router.release(first)).toBe(false)
    h.router.send('pane', 'session:semantic-event', [{ textSoFar: 'new run' }])
    expect(h.deliveries.map(d => d.args)).toEqual([[{ textSoFar: 'new run' }]])
    expect(h.gaps[0]?.gap).toMatchObject({ ownershipRevision: next.revision, reason: 'owner_replaced', missedEvents: 1 })
  })

  it('does not let a different registered window steal ownership by claiming stale session metadata', () => {
    const h = harness()
    const first = h.router.claim('pane', 'left')!
    expect(h.router.claim('pane', 'right')).toBeNull()
    h.router.send('pane', 'session:screen', ['belongs to left'])
    expect(h.router.owner('pane')).toBe(first)
    expect(h.deliveries.map(d => d.windowId)).toEqual(['left'])
  })

  it('requires a new claim after renderer navigation and never flushes the old renderer buffer', () => {
    const h = harness()
    h.router.claim('pane', 'left')
    h.windows.get('left')!.accepting = false
    h.router.send('pane', 'session:screen', [{ plain: 'before reload' }])
    h.windows.set('left', { generation: 2, accepting: true })
    h.router.rendererChanged('left')
    h.router.windowAvailable('left')
    expect(h.router.send('pane', 'session:screen', [{ plain: 'still unclaimed' }])).toBe('quarantined')
    expect(h.deliveries).toEqual([])
    h.router.claim('pane', 'left')
    h.router.send('pane', 'session:screen', [{ plain: 'after explicit recovery' }])
    expect(h.deliveries.map(d => d.args)).toEqual([[{ plain: 'after explicit recovery' }]])
    expect(h.gaps[0]?.gap.reason).toBe('renderer_replaced')
  })

  it('owns a snapshot of held observations rather than a mutable producer object', () => {
    const h = harness()
    h.router.claim('pane', 'left')
    h.windows.get('left')!.accepting = false
    const payload = { entries: ['captured'] }
    h.router.send('pane', 'session:jsonl-entries', [payload])
    payload.entries[0] = 'mutated later'
    h.windows.get('left')!.accepting = true
    h.router.windowAvailable('left')
    expect(h.deliveries[0]?.args).toEqual([{ entries: ['captured'] }])
  })

  it('bounds queued items across sessions while unrelated live windows keep delivering', () => {
    const h = harness({ totalEvents: 2 })
    for (const id of ['a', 'b', 'c']) h.router.claim(id, 'left')
    h.router.claim('live', 'right')
    h.windows.get('left')!.accepting = false
    expect(h.router.send('a', 'session:screen', ['a'])).toBe('held')
    expect(h.router.send('b', 'session:screen', ['b'])).toBe('held')
    expect(h.router.send('c', 'session:screen', ['c'])).toBe('quarantined')
    expect(h.router.diagnostics().pendingEvents).toBe(2)
    expect(h.router.send('live', 'session:screen', ['still live'])).toBe('delivered')
    h.windows.get('left')!.accepting = true
    h.router.windowAvailable('left')
    expect(h.gaps.some(g => g.gap.sessionId === 'c' && g.gap.reason === 'queue_limit')).toBe(true)
    expect(h.deliveries.map(d => d.args[0])).toEqual(['still live', 'a', 'b'])
  })

  it('discards an overflowing per-session queue with an explicit gap instead of retaining an unbounded tail', () => {
    const h = harness({ eventsPerSession: 1 })
    h.router.claim('pane', 'left')
    h.windows.get('left')!.accepting = false
    h.router.send('pane', 'session:semantic-event', ['prefix'])
    expect(h.router.send('pane', 'session:semantic-event', ['completion'])).toBe('quarantined')
    expect(h.router.diagnostics()).toMatchObject({ pendingEvents: 0, pendingBytes: 0 })
    h.windows.get('left')!.accepting = true
    h.router.windowAvailable('left')
    expect(h.gaps[0]?.gap).toMatchObject({ reason: 'queue_limit', missedEvents: 2 })
    expect(h.deliveries).toEqual([])
  })

  it('limits retained bytes before cloning, including a typed-array backing allocation', () => {
    const h = harness({ bytesPerSession: 1024, totalBytes: 2048 })
    h.router.claim('pane', 'left')
    h.windows.get('left')!.accepting = false
    const hugeBacking = new Uint8Array(new ArrayBuffer(4096), 0, 1)
    expect(h.router.send('pane', 'session:terminal-data', [hugeBacking])).toBe('quarantined')
    expect(h.router.send('pane', 'session:screen', ['x'.repeat(1024)])).toBe('quarantined')
    expect(h.router.diagnostics()).toMatchObject({ pendingEvents: 0, pendingBytes: 0 })
  })

  it('expires held content by admitted age, even if more events keep arriving', async () => {
    const h = harness({ pendingMs: 100 })
    h.router.claim('pane', 'left')
    h.windows.get('left')!.accepting = false
    h.router.send('pane', 'session:terminal-data', ['first'])
    await vi.advanceTimersByTimeAsync(90)
    h.router.send('pane', 'session:terminal-data', ['later'])
    await vi.advanceTimersByTimeAsync(10)
    expect(h.router.diagnostics()).toMatchObject({ pendingEvents: 0, pendingBytes: 0 })
    h.windows.get('left')!.accepting = true
    h.router.windowAvailable('left')
    expect(h.gaps[0]?.gap).toMatchObject({ reason: 'queue_expired', missedEvents: 2 })
    expect(h.deliveries).toEqual([])
  })

  it('bounds never-owned metadata and rate-limits incidents without retaining lost content', () => {
    const h = harness({ gapRecords: 2 })
    for (const id of ['a', 'b', 'c']) h.router.send(id, 'session:screen', ['private'])
    expect(h.router.diagnostics().gapRecords).toBe(2)
    expect(h.incident).toHaveBeenCalledTimes(1)
    h.router.claim('a', 'right')
    expect(h.gaps[0]?.gap).toMatchObject({ reason: 'metadata_evicted', missedEvents: 0 })
    h.router.claim('unrelated-new-pane', 'left')
    expect(h.gaps).toHaveLength(1)
    expect(h.deliveries).toEqual([])
  })

  it('cannot acknowledge newer loss with an older resync ticket', () => {
    const h = harness()
    h.router.send('pane', 'session:screen', ['unowned'])
    const lease = h.router.claim('pane', 'left')!
    const oldGap = h.gaps[0]!.gap
    h.windows.get('left')!.accepting = false
    h.router.send('pane', 'session:screen', [() => 'unsupported'])
    h.windows.get('left')!.accepting = true
    h.router.windowAvailable('left')
    const nextGap = h.gaps.at(-1)!.gap
    expect(nextGap.gapRevision).not.toBe(oldGap.gapRevision)
    expect(h.router.acknowledgeGap(lease, oldGap.gapRevision)).toBe(false)
    expect(h.router.acknowledgeGap(lease, nextGap.gapRevision)).toBe(true)
    expect(h.router.diagnostics().gapRecords).toBe(0)
  })

  it('recovers expired metadata for an already claimed late pane once, and remembers later new loss separately', () => {
    const h = harness({ gapMs: 20 })
    h.router.send('pane', 'session:screen', ['unknown'])
    const lease = h.router.claim('pane', 'left')!
    vi.advanceTimersByTime(21)
    const recovered = h.router.gapsForWindow('left')
    expect(recovered).toEqual([expect.objectContaining({ sessionId: 'pane', reason: 'metadata_evicted' })])
    expect(h.router.acknowledgeGap(lease, recovered[0]!.gapRevision)).toBe(true)
    expect(h.router.gapsForWindow('left')).toEqual([])
    h.deliver.mockReturnValueOnce('uncertain')
    h.router.send('pane', 'session:screen', ['later gap'])
    vi.advanceTimersByTime(21)
    expect(h.router.gapsForWindow('left')).toEqual([expect.objectContaining({ sessionId: 'pane', reason: 'metadata_evicted' })])
  })

  it('bounds unknown metadata keys and refuses throwing provider objects without escaping lifecycle delivery', () => {
    const h = harness()
    expect(h.router.send('x'.repeat(100_000), 'session:screen', ['ignored'])).toBe('quarantined')
    expect(h.router.diagnostics().gapRecords).toBe(0)
    h.router.claim('pane', 'left')
    h.windows.get('left')!.accepting = false
    const payload = new Proxy({}, { getPrototypeOf: () => { throw new Error('provider trap') } })
    expect(h.router.send('pane', 'session:screen', [payload])).toBe('quarantined')
    expect(h.router.diagnostics().pendingBytes).toBe(0)
  })

  it('does not invoke getters when admitting held provider data', () => {
    const h = harness()
    h.router.claim('pane', 'left')
    h.windows.get('left')!.accepting = false
    const getter = vi.fn(() => 'secret')
    expect(h.router.send('pane', 'session:screen', [Object.defineProperty({}, 'plain', { enumerable: true, get: getter })])).toBe('quarantined')
    expect(getter).not.toHaveBeenCalled()
  })

  it('does not retry bytes after an uncertain IPC send', () => {
    const h = harness()
    h.router.claim('pane', 'left')
    h.deliver.mockReturnValueOnce('uncertain')
    expect(h.router.send('pane', 'session:terminal-data', ['ambiguous bytes'])).toBe('quarantined')
    expect(h.gaps[0]?.gap.reason).toBe('delivery_failed')
    h.router.windowAvailable('left')
    expect(h.deliver).toHaveBeenCalledTimes(1)
    expect(h.gaps[0]?.gap.reason).toBe('delivery_failed')
  })

  it('does not double-deliver a queued head or corrupt budgets when a sink transfers ownership synchronously', () => {
    const h = harness()
    h.router.claim('pane', 'left')
    h.windows.get('left')!.accepting = false
    h.router.send('pane', 'session:screen', ['one'])
    h.router.send('pane', 'session:exit', ['two'])
    h.deliver.mockImplementationOnce((lease, channel, args) => {
      h.deliveries.push({ windowId: lease.windowId, channel, args })
      h.router.transfer('pane', 'right')
      return 'sent'
    })
    h.windows.get('left')!.accepting = true
    h.router.windowAvailable('left')
    expect(h.deliveries).toEqual([
      { windowId: 'left', channel: 'session:screen', args: ['one'] },
      { windowId: 'right', channel: 'session:exit', args: ['two'] },
    ])
    expect(h.router.diagnostics()).toMatchObject({ pendingEvents: 0, pendingBytes: 0 })
  })
})
