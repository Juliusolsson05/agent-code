import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createSession, createTerminalSession } = vi.hoisted(() => ({
  createSession: vi.fn(),
  createTerminalSession: vi.fn(),
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
  async start(): Promise<void> {
    this.emit('started', { projectDir: '/tmp/project' })
  }

  async stop(): Promise<void> {}

  write(): void {}

  resize(): void {}
}

// #746: spinner-only repaints must not reach the manager's listeners (the
// forwarder, the remote server, the recorder) but must still update the raw
// snapshot cache that MCP/debug readers consult.

const THINKING = "> fix it\n\n✻ Beboppin'… (5s · thinking…)\n"
const THINKING_TICK = "> fix it\n\n✽ Beboppin'… (6s · thinking…)\n"
const OUTPUT = THINKING_TICK + '⏺ Read(README.md)\n'

function frame(plain: string) {
  return { plain, markdown: plain, recent: plain, recentMarkdown: plain, picker: { visible: false, items: [] } }
}

describe('SessionManager screen-frame gate', () => {
  beforeEach(() => {
    createSession.mockReset()
    createTerminalSession.mockReset()
  })

  it('drops a spinner tick for listeners but keeps the raw snapshot current', async () => {
    const { SessionManager } = await import('./sessionManager')
    const session = new FakeAgentSession()
    createSession.mockImplementation(() => session)
    const manager = new SessionManager()
    const seen: string[] = []
    manager.on('screen', payload => seen.push((payload as { plain: string }).plain))

    const { sessionId } = await manager.spawn({ kind: 'claude', cwd: '/tmp/project' })
    session.emit('screen', frame(THINKING))
    session.emit('screen', frame(THINKING_TICK))
    expect(seen).toEqual([THINKING])
    expect(manager.getScreenSnapshot(sessionId)?.plain).toBe(THINKING_TICK)

    session.emit('screen', frame(OUTPUT))
    expect(seen).toEqual([THINKING, OUTPUT])
  })

  it('pages raw output without acquiring a terminal subscription and guards input by backend lifetime', async () => {
    const { SessionManager } = await import('./sessionManager')
    const { terminalBackendCapabilities } = await import('./sessions/terminalControl')
    const session = new FakeAgentSession()
    const write = vi.spyOn(session, 'write')
    const resize = vi.spyOn(session, 'resize')
    createSession.mockImplementation(() => session)
    const manager = new SessionManager()
    const forwarded: string[] = []
    manager.on('agent-pty-data', event => forwarded.push(event.data))
    const { sessionId } = await manager.spawn({ kind: 'claude', cwd: '/tmp/project' })
    const capabilities = terminalBackendCapabilities(manager)
    const context = { requestId: 'raw-probe', caller: { kind: 'application' as const, id: 'renderer' }, owner: { kind: 'main' as const, generation: 'one' } }
    const identity = { sessionId, provider: 'claude', cwd: '/tmp/project' }
    const invoke = (id: string, input: unknown) => capabilities.find(item => item.descriptor.id === id)!.execute(input, context)
    // Deliberate codec workload through the manager's actual PTY event path;
    // this does not claim to be a recorded provider transcript.
    const raw = '\x1b[32m' + '😀'.repeat(180) + '\x1b[0m\r\n'
    session.emit('pty-data', raw)
    const first = await invoke('sessions.terminalRead', { ...identity, range: 'retained', maxChars: 256 })
    if (!first.ok) throw new Error(JSON.stringify(first))
    const page = first.value as { raw: string; nextCursor: string; sessionRunId: string }
    session.emit('pty-data', 'later output')
    const second = await invoke('sessions.terminalRead', { ...identity, range: 'retained', cursor: page.nextCursor, maxChars: 256 })
    if (!second.ok) throw new Error(JSON.stringify(second))
    expect(page.raw + (second.value as { raw: string }).raw).toBe(raw)
    expect(forwarded).toEqual([])
    expect(resize).not.toHaveBeenCalled()
    expect(manager.attachAgentPty(sessionId)).toBe(raw + 'later output')
    await invoke('sessions.terminalRead', identity)
    manager.detachAgentPty(sessionId)
    session.emit('pty-data', 'after detach')
    expect(forwarded).toEqual([])
    expect(await invoke('sessions.terminalInput', { ...identity, sessionRunId: 'old-process', data: 'wrong' })).toMatchObject({ ok: false, error: { outcome: 'not_started' } })
    expect(write).not.toHaveBeenCalled()
    expect(await invoke('sessions.terminalInput', { ...identity, sessionRunId: page.sessionRunId, data: '\x1b' })).toMatchObject({ ok: true, value: { delivered: true } })
    expect(write).toHaveBeenCalledExactlyOnceWith('\x1b')
    await manager.kill(sessionId)
  })
})
