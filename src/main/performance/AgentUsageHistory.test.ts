import { describe, expect, it } from 'vitest'
import type { MonitorProcessPage, MonitorProcessRow } from '@shared/performance/processSnapshot.js'
import { AgentUsageHistory, summarizeProcessPage } from './AgentUsageHistory.js'

const row = (over: Partial<MonitorProcessRow>): MonitorProcessRow => ({
  identity: `${over.pid ?? 0}:1`, pid: 1, parentPid: null, creationTime: 1, type: 'agent',
  sessionIds: [], sharedSessionCount: 0, cpuPercent: 1, memoryBytes: 100, quality: 'ok', ...over,
})
const page = (at: number, rows: MonitorProcessRow[]): MonitorProcessPage => ({
  summary: { sampledAt: at, count: rows.length, cpuPercent: 0, memoryBytes: 0, quality: 'ok', sessionCount: 0, missingRoots: 0, truncated: false },
  rows, total: rows.length,
})

describe('agent usage attribution', () => {
  it('charges sole owners, counts shared helpers once, and keeps buckets summing to the total', () => {
    const { composition, sessions } = summarizeProcessPage(page(1000, [
      row({ pid: 1, type: 'main', memoryBytes: 500, cpuPercent: 10 }),
      row({ pid: 2, type: 'agent', provider: 'claude', sessionIds: ['a'], sharedSessionCount: 1, memoryBytes: 300, cpuPercent: 20 }),
      row({ pid: 3, type: 'agent', sessionIds: ['a'], sharedSessionCount: 1, memoryBytes: 200, cpuPercent: null }),
      row({ pid: 4, type: 'terminal', provider: 'terminal', sessionIds: ['t'], sharedSessionCount: 1, memoryBytes: 50, cpuPercent: 1 }),
      row({ pid: 5, type: 'agent', sessionIds: ['a', 'b'], sharedSessionCount: 2, memoryBytes: 400, cpuPercent: 5 }),
      row({ pid: 6, type: 'child', memoryBytes: 25, cpuPercent: 0 }),
      row({ pid: null, identity: 'session:c', sessionIds: ['c'], sharedSessionCount: 1, memoryBytes: null, cpuPercent: null, quality: 'unsupported' }),
    ]))
    expect(composition.total).toEqual({ memoryBytes: 1475, cpuPercent: 36 })
    const parts = [composition.app, composition.agents, composition.terminals, composition.shared, composition.other]
    expect(parts.reduce((sum, part) => sum + part.memoryBytes, 0)).toBe(composition.total.memoryBytes)
    expect(sessions.get('a')).toMatchObject({ kind: 'agent', provider: 'claude', processCount: 2, memoryBytes: 500, cpuPercent: 20, complete: false })
    expect(sessions.get('t')).toMatchObject({ kind: 'terminal', memoryBytes: 50 })
    // A root that could not be discovered is visible but is not a process.
    expect(sessions.get('c')).toMatchObject({ processCount: 0, memoryBytes: null, cpuPercent: null })
    expect(sessions.has('b')).toBe(false)
  })

  it('keeps fifteen minutes of ordered history and ranks only sessions still running', () => {
    const history = new AgentUsageHistory()
    const agent = (memoryBytes: number) => row({ pid: 2, sessionIds: ['a'], sharedSessionCount: 1, memoryBytes })
    history.record(page(0, [agent(100), row({ pid: 3, sessionIds: ['gone'], sharedSessionCount: 1, memoryBytes: 900 })]))
    history.record(page(5000, [agent(200)]))
    // A resent or clock-stepped page must not append out of order.
    history.record(page(5000, [agent(999)]))
    history.record(page(1000, [agent(999)]))
    let usage = history.read(8 * 1024 ** 3)
    expect(usage.sessions.map(session => session.sessionId)).toEqual(['a'])
    expect(usage.sessions[0]!.history).toEqual([[0, 100, 1], [5000, 200, 1]])
    expect(usage.systemMemoryBytes).toBe(8 * 1024 ** 3)

    history.record(page(16 * 60_000, [agent(300)]))
    usage = history.read(1)
    expect(usage.sessions[0]!.history).toEqual([[16 * 60_000, 300, 1]])
    expect(usage.composition.map(sample => sample.at)).toEqual([16 * 60_000])
  })

  it('caps tracked sessions at 256, evicting the oldest-seen, and re-admits an evicted live session with fresh history', () => {
    const history = new AgentUsageHistory()
    // 257 sole-owner sessions in one page: the 257th admission must evict the
    // oldest seenAt. All rows share a timestamp, so "oldest" falls to the
    // first-inserted entry — deterministic even under Map iteration order.
    const rows = Array.from({ length: 257 }, (_, index) =>
      row({ pid: index + 1, identity: `${index + 1}:1`, sessionIds: [`s${index}`], sharedSessionCount: 1, memoryBytes: 100 }))
    history.record(page(0, rows))
    let usage = history.read(1)
    expect(usage.sessions).toHaveLength(256)
    expect(usage.sessions.some(session => session.sessionId === 's0')).toBe(false)

    // The evicted session is still running: its next page re-admits it, with
    // history that starts over rather than pretending the gap was observed.
    history.record(page(5000, [row({ pid: 1, identity: '1:1', sessionIds: ['s0'], sharedSessionCount: 1, memoryBytes: 100 })]))
    usage = history.read(1)
    expect(usage.sessions.map(session => session.sessionId)).toEqual(['s0'])
    expect(usage.sessions[0]!.history).toEqual([[5000, 100, 1]])
  })

  // WHY this is pinned: the overview's "heaviest agent" tile and the ranking
  // table both treat sessions[0] as the biggest consumer. The sort order is
  // part of the IPC contract, not an accident of Map iteration.
  it('ranks concurrently-live sessions by memory, descending', () => {
    const history = new AgentUsageHistory()
    const rows = [
      row({ pid: 1, sessionIds: ['small'], sharedSessionCount: 1, memoryBytes: 100 * 1024 ** 2 }),
      row({ pid: 2, sessionIds: ['large'], sharedSessionCount: 1, memoryBytes: 900 * 1024 ** 2 }),
      row({ pid: 3, sessionIds: ['unread'], sharedSessionCount: 1, memoryBytes: null, cpuPercent: null }),
    ]
    history.record(page(0, rows))
    expect(history.read(1).sessions.map(session => session.sessionId)).toEqual(['large', 'small', 'unread'])
  })
})
