import { expect, it, vi } from 'vitest'

import { PerformanceService } from './PerformanceService.js'
import { SessionManager } from '@main/sessionManager.js'

// #369: the Codex proxy adapters' retained state is sampled into the 5 s
// heartbeat next to RSS, so a retention leak shows up as a climbing gauge
// rather than as a main-process OOM.

it('samples registered gauge sources, skipping ones that throw or have nothing to say', () => {
  const service = new PerformanceService()
  const metric = vi.spyOn(service, 'metric').mockImplementation(() => {})
  service.setGaugeSource('codex.proxy.flows', () => 3)
  service.setGaugeSource('broken', () => { throw new Error('reader failed') })
  service.setGaugeSource('absent', () => null)
  // A reader that computes garbage (say `undefined` summed into a count)
  // must not append a NaN row to the metrics file every 5 s.
  service.setGaugeSource('garbage', () => Number.NaN)
  service.sampleGaugeSources()
  expect(metric.mock.calls).toEqual([['codex.proxy.flows', 3, 'gauge']])

  service.setGaugeSource('codex.proxy.flows', null)
  metric.mockClear()
  service.sampleGaugeSources()
  expect(metric).not.toHaveBeenCalled()
})

it('samples the registered gauges on every heartbeat tick', () => {
  // #1238 review B: the registry above can be perfect and still never run.
  // The heartbeat is the only caller of sampleGaugeSources, so a gauge that
  // is not reached from the tick is a gauge that is silently absent from the
  // #369 heavy-run evidence. Drives the private probe loop directly: start()
  // also opens a run directory and exporters this test does not need.
  vi.useFakeTimers()
  try {
    const service = new PerformanceService()
    const metric = vi.spyOn(service, 'metric').mockImplementation(() => {})
    service.setGaugeSource('codex.proxy.flows', () => 4)
    ;(service as unknown as { startProbes(): void }).startProbes()
    vi.advanceTimersByTime(5_000)
    expect(metric.mock.calls.filter(([name]) => name === 'codex.proxy.flows'))
      .toEqual([['codex.proxy.flows', 4, 'gauge']])
    service.stop()
  } finally {
    vi.useRealTimers()
  }
})

it('sums retained proxy state across Codex sessions and ignores sessions without an adapter', () => {
  const sessions = new Map<string, { session: object }>([
    ['codex-a', { session: { proxyDiagnostics: () => ({ flows: 2, bufferedChars: 10 }) } }],
    ['codex-b', { session: { proxyDiagnostics: () => ({ flows: 1, bufferedChars: 5 }) } }],
    ['codex-no-proxy', { session: { proxyDiagnostics: () => null } }],
    ['claude', { session: {} }],
  ])
  const total = SessionManager.prototype.codexProxyDiagnostics.call({ sessions } as never)
  expect(total).toEqual({ flows: 3, bufferedChars: 15 })
})
