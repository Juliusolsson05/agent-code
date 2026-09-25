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
  service.sampleGaugeSources()
  expect(metric.mock.calls).toEqual([['codex.proxy.flows', 3, 'gauge']])

  service.setGaugeSource('codex.proxy.flows', null)
  metric.mockClear()
  service.sampleGaugeSources()
  expect(metric).not.toHaveBeenCalled()
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
