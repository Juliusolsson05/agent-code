import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { ClaudeSession } from './claudeSession.js'

// The app half of #1040's sleep-ordering fix.
//
// ClaudeSession waits a minute after a suspension before sealing flows, so a
// stream that survived the sleep is not cut off (#963). But a stream that did
// NOT survive usually reports its own death first — the proxy's `error` hook
// fires seconds after wake — and whichever signal arrives first decides what
// the user is told. The adapter therefore has to learn the suspension instant
// immediately; sealing still happens on the timer.

describe('ClaudeSession.noteSystemSuspension', () => {
  it('tells the proxy adapter the suspension instant before the seal grace', () => {
    const noteSuspension = vi.fn()
    const sealFlowsSilentSince = vi.fn()
    const session = new ClaudeSession()
    ;(session as unknown as { headless: unknown }).headless = {
      proxy: { noteSuspension, sealFlowsSilentSince },
    }

    const suspendedAt = Date.parse('2026-09-20T04:00:00.000Z')
    session.noteSystemSuspension({ suspendedAt, resumedAt: suspendedAt + 60_000, source: 'power-monitor' })

    expect(noteSuspension).toHaveBeenCalledWith(suspendedAt)
    // The seal itself still waits out the grace period.
    expect(sealFlowsSilentSince).not.toHaveBeenCalled()
  })

  it('does nothing when there is no proxy (a session without one still works)', () => {
    const session = new ClaudeSession()
    expect(() => session.noteSystemSuspension({
      suspendedAt: 1, resumedAt: 2, source: 'power-monitor',
    })).not.toThrow()
  })
})

// #1309 round 2 B: the production adapter the rollback reads. Both halves
// must come from the live headless at the same call, and a session without a
// headless reports nothing rather than an empty (= "cleared") screen.
describe('ClaudeSession.readComposer', () => {
  it('reads screen and attributes from the live headless together', () => {
    const session = new ClaudeSession()
    expect(session.readComposer()).toBeNull()
    const attributes = { dim: 0, inverse: 1, plain: 4 }
    ;(session as unknown as { headless: unknown }).headless = {
      getScreen: () => '❯ typed',
      getComposerAttributes: () => attributes,
    }
    expect(session.readComposer()).toEqual({ screen: '❯ typed', attributes })
  })
})

// Review of #1376 (a, b, c): the app subscribed to the proxy's `event` channel only, so the
// `transport-gap` claude-code-headless#64 reports (generations rotated away unread) never left the
// package — and deleting even the `event` subscription passed every Claude runtime test.
describe('ClaudeSession proxy wiring', () => {
  function wired() {
    const session = new ClaudeSession()
    const proxy = new EventEmitter()
    const handleProxyTransportEvent = vi.fn()
    const sealFlowsForTransportGap = vi.fn()
    const internals = session as unknown as {
      proxyServer: unknown
      headless: unknown
      attachProxyServer(): void
      detachProxyServer(): void
    }
    internals.proxyServer = proxy
    internals.headless = { handleProxyTransportEvent, proxy: { sealFlowsForTransportGap } }
    internals.attachProxyServer()
    return { session, proxy, handleProxyTransportEvent, sealFlowsForTransportGap, detach: () => internals.detachProxyServer() }
  }

  it('forwards every proxy event to the adapter', () => {
    const { proxy, handleProxyTransportEvent } = wired()
    const chunk = { kind: 'response-chunk', flow_id: 'f1', chunk_b64: 'eA==' }
    proxy.emit('event', chunk)
    expect(handleProxyTransportEvent).toHaveBeenCalledWith(chunk)
  })

  it('surfaces a transport gap as a session event', () => {
    const { session, proxy } = wired()
    const gaps: unknown[] = []
    session.on('proxy-transport-gap', gap => { gaps.push(gap) })
    const gap = { lostGenerations: 2, since: 1_000, until: 5_000 }
    proxy.emit('transport-gap', gap)
    expect(gaps).toEqual([gap])
  })

  // #1381: the flows that were streaming across the lost span are missing frames. The adapter is
  // sealed at the gap's place in the event order — before the re-emit (SessionManager's durable
  // row follows the seal) and before the next post-gap event reaches it.
  it('seals the adapter at the gap, before the re-emit and before any post-gap event', () => {
    const { session, proxy, handleProxyTransportEvent, sealFlowsForTransportGap } = wired()
    const order: string[] = []
    sealFlowsForTransportGap.mockImplementation(() => { order.push('seal') })
    handleProxyTransportEvent.mockImplementation(() => { order.push('event') })
    session.on('proxy-transport-gap', () => { order.push('re-emit') })
    proxy.emit('event', { kind: 'response-chunk', flow_id: 1 })
    proxy.emit('transport-gap', { lostGenerations: 1, since: 1, until: 2 })
    proxy.emit('event', { kind: 'response-chunk', flow_id: 1 })
    expect(order).toEqual(['event', 'seal', 're-emit', 'event'])
  })

  it('detaches both channels', () => {
    const { proxy, detach } = wired()
    detach()
    expect(proxy.listenerCount('event') + proxy.listenerCount('transport-gap')).toBe(0)
  })
})
