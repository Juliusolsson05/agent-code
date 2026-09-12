import { describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({ page: { summary: {
  sampledAt: 100, count: 1, cpuPercent: 4, memoryBytes: 1024, quality: 'ok',
  sessionCount: 1, missingRoots: 0, truncated: false,
}, rows: [{ identity: '20:1', pid: 20, parentPid: 1, creationTime: 1,
  type: 'agent', provider: 'claude', sessionIds: ['live'], sharedSessionCount: 1,
  cpuPercent: 4, memoryBytes: 1024, quality: 'ok' }], total: 1 } }))
vi.mock('./MonitorCoordinator.js', () => ({ monitorCoordinator: { readAllProcesses: () => harness.page } }))
import { ProcessTelemetry } from './ProcessTelemetry.js'

describe('cached pane compatibility', () => {
  it('preserves activity state and never publishes cached metrics for exited sessions', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
    const manager = { getProcessTelemetryTargets: () => [
      { sessionId: 'live', kind: 'claude', pid: 20, exited: false, lastActivityAt: 99_000 },
      { sessionId: 'idle', kind: 'codex', pid: 21, exited: false, lastActivityAt: 1_000 },
      { sessionId: 'gone', kind: 'claude', pid: 20, exited: true, lastActivityAt: 99_000 },
    ] }
    const result = await new ProcessTelemetry(manager as never).snapshot()
    expect(result.panes.map(row => row.status)).toEqual(['running', 'idle', 'exited'])
    expect(result.panes[0]).toMatchObject({ cpuPercent: 4, memoryBytes: 1024 })
    expect(result.panes[2]).toMatchObject({ cpuPercent: null, memoryBytes: null, childCount: 0 })
  })
})
