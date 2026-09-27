import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createSession, createTerminalSession } = vi.hoisted(() => ({
  createSession: vi.fn(),
  createTerminalSession: vi.fn(),
}))

vi.mock('@main/workspaceDirectory.js', () => ({
  // These suites spawn into synthetic paths ('/tmp/project', '/recorded/worktree')
  // that intentionally do not exist on disk. The real spawn-path guard stats the
  // cwd, so it is stubbed here; workspaceDirectory.test.ts covers the guard
  // itself, and the missing-folder case below overrides this mock to prove the
  // manager surfaces it.
  MissingWorkspaceDirectoryError: class MissingWorkspaceDirectoryError extends Error {
    constructor(readonly cwd: string) {
      super(`Workspace folder is missing: ${cwd}`)
      this.name = 'MissingWorkspaceDirectoryError'
    }
  },
  assertWorkspaceDirectoryExists: vi.fn(async () => {}),
}))

vi.mock('@providers/registry.main.js', () => ({
  getMainProvider: () => ({
    name: 'Claude',
    createSession,
    createTerminalSession,
  }),
}))

vi.mock('@main/setup/toolchain.js', () => ({
  getToolPath: () => '/usr/bin/true',
}))

vi.mock('@main/performance/PerformanceService.js', () => ({
  performanceService: {
    mark: vi.fn(),
    record: vi.fn(),
    error: vi.fn(),
    metric: vi.fn(),
    span: () => ({ end: vi.fn(), fail: vi.fn() }),
  },
}))

vi.mock('@main/storage/feedDebugLog.js', () => ({
  forgetFeedDebugSession: vi.fn(),
}))

class FakeAgentSession extends EventEmitter {
  // The provider conversation this process is running (#1381 keys the durable gap rows by it).
  conversationId: string | null = 'conv-1'
  getProviderSessionId(): string | null { return this.conversationId }

  async start(): Promise<void> {
    this.emit('started', { projectDir: '/tmp/project' })
  }

  async stop(): Promise<void> {}

  write(): void {}

  resize(): void {}
}

// Review of #1376 (a, b, c): claude-code-headless#64 reports proxy generations deleted before the
// app read them as `transport-gap`; ClaudeSession re-emits it as `proxy-transport-gap`. This pins
// the manager's half: an always-on incident for the session, and the event re-emitted with its id.
describe('a Claude proxy transport gap', () => {
  beforeEach(() => {
    createSession.mockReset()
  })

  it('is recorded as an incident and re-emitted with the session id', async () => {
    const { SessionManager } = await import('./sessionManager')
    const session = new FakeAgentSession()
    createSession.mockImplementationOnce(() => session)
    const incidents: Array<{ kind: string; context?: Record<string, unknown> }> = []
    const journal = { recordIncident: (incident: { kind: string; context?: Record<string, unknown> }) => { incidents.push(incident) }, record: vi.fn(), recordError: vi.fn() }
    const manager = new SessionManager(null, null, journal as never)
    const gaps: unknown[] = []
    manager.on('proxy-transport-gap', gap => { gaps.push(gap) })

    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    session.emit('proxy-transport-gap', { lostGenerations: 3, since: 1_000, until: 9_000 })

    const record = { id: expect.any(String), since: 1_000, until: 9_000, lostGenerations: 3 }
    expect(gaps).toEqual([{ sessionId: 's1', gap: record }])
    expect(incidents).toContainEqual(expect.objectContaining({
      kind: 'claude.proxy_transport_gap',
      context: { sessionId: 's1', lostGenerations: 3, since: 1_000, until: 9_000 },
    }))
  })

  // #1381 option B (owner-approved by B6): the gap is a DURABLE feed row. A renderer that reloads
  // rebuilds its feed from main, and an agent reload respawns under the same id — the record must
  // survive both, which is why it is not one of the caches that die with the process.
  it('is held for its conversation, surviving the respawn an agent reload does', async () => {
    const { SessionManager } = await import('./sessionManager')
    const first = new FakeAgentSession()
    const second = new FakeAgentSession()
    createSession.mockImplementationOnce(() => first).mockImplementationOnce(() => second)
    const journal = { recordIncident: vi.fn(), record: vi.fn(), recordError: vi.fn() }
    const manager = new SessionManager(null, null, journal as never)

    expect(manager.getTransportGaps('conv-1')).toEqual([])
    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    first.emit('proxy-transport-gap', { lostGenerations: 1, since: null, until: 5_000 })
    first.emit('exit', { exitCode: 0 })
    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    second.emit('proxy-transport-gap', { lostGenerations: 2, since: 6_000, until: 7_000 })

    const held = manager.getTransportGaps('conv-1')
    expect(held.map(gap => [gap.since, gap.until, gap.lostGenerations])).toEqual([[null, 5_000, 1], [6_000, 7_000, 2]])
    expect(new Set(held.map(gap => gap.id)).size).toBe(2)
    expect(manager.getTransportGaps('s1')).toEqual([])
  })

  // A gap is a fact about one conversation. A pane that moves to a new conversation (Claude /clear)
  // must not carry the old conversation's row into it.
  it('does not follow the pane into a new conversation', async () => {
    const { SessionManager } = await import('./sessionManager')
    const session = new FakeAgentSession()
    createSession.mockImplementationOnce(() => session)
    const manager = new SessionManager(null, null, { recordIncident: vi.fn(), record: vi.fn(), recordError: vi.fn() } as never)
    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    session.emit('proxy-transport-gap', { lostGenerations: 1, since: 1, until: 2 })
    session.conversationId = 'conv-2'
    session.emit('proxy-transport-gap', { lostGenerations: 1, since: 3, until: 4 })
    expect(manager.getTransportGaps('conv-1').map(gap => gap.until)).toEqual([2])
    expect(manager.getTransportGaps('conv-2').map(gap => gap.until)).toEqual([4])
  })

  // Focused review of #1376 (c): a replaced session's late gap must not be recorded against the
  // session id its successor now owns.
  it('ignores a gap from a session that has been replaced', async () => {
    const { SessionManager } = await import('./sessionManager')
    const first = new FakeAgentSession()
    const second = new FakeAgentSession()
    createSession.mockImplementationOnce(() => first).mockImplementationOnce(() => second)
    const incidents: Array<{ kind: string }> = []
    const journal = { recordIncident: (incident: { kind: string }) => { incidents.push(incident) }, record: vi.fn(), recordError: vi.fn() }
    const manager = new SessionManager(null, null, journal as never)
    const gaps: unknown[] = []
    manager.on('proxy-transport-gap', gap => { gaps.push(gap) })

    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    first.emit('exit', { exitCode: 0 })
    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    first.emit('proxy-transport-gap', { lostGenerations: 1 })

    expect(gaps).toEqual([])
    expect(incidents.filter(incident => incident.kind === 'claude.proxy_transport_gap')).toEqual([])
  })
})
