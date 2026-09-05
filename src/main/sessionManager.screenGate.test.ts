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
})
