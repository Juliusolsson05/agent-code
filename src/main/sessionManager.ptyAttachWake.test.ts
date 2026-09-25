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
  async start(): Promise<void> {
    this.emit('started', { projectDir: '/tmp/project' })
  }

  async stop(): Promise<void> {}

  write(): void {}

  resize(): void {}
}

// #1281 (C2 hunt): a terminal-view pane stays mounted while its provider
// process exits and is woken under the SAME session id (a delivery, a control
// call or a server restart can wake it without remounting the pane). The
// attach count describes the renderer's VIEW, not the process, but process
// cleanup deleted it, so the new process's bytes were buffered and never
// forwarded: the xterm stayed frozen on the dead screen while keystrokes
// reached the new process unseen, until a remount.
describe('raw PTY view across a same-id wake', () => {
  beforeEach(() => {
    createSession.mockReset()
  })

  it('keeps forwarding to a still-attached view after the process exits and is woken again', async () => {
    const { SessionManager } = await import('./sessionManager')
    const first = new FakeAgentSession()
    const second = new FakeAgentSession()
    createSession.mockImplementationOnce(() => first).mockImplementationOnce(() => second)
    const manager = new SessionManager()
    const forwarded: string[] = []
    manager.on('agent-pty-data', event => forwarded.push(event.data))

    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    expect(manager.attachAgentPty('s1')).not.toBeNull()
    first.emit('pty-data', 'old process')
    first.emit('exit', { exitCode: 1 })

    await manager.recover({ sessionId: 's1', kind: 'claude', cwd: '/tmp/project' })
    second.emit('pty-data', 'fresh process')
    expect(forwarded).toEqual(['old process', 'fresh process'])

    // The view's own detach still ends forwarding.
    manager.detachAgentPty('s1')
    second.emit('pty-data', 'after detach')
    expect(forwarded).not.toContain('after detach')
  })

  it('forgets the view when the pane detaches after its process died', async () => {
    const { SessionManager } = await import('./sessionManager')
    const first = new FakeAgentSession()
    const second = new FakeAgentSession()
    createSession.mockImplementationOnce(() => first).mockImplementationOnce(() => second)
    const manager = new SessionManager()
    const forwarded: string[] = []
    manager.on('agent-pty-data', event => forwarded.push(event.data))
    await manager.recover({ sessionId: 's2', kind: 'claude', cwd: '/tmp/project' })
    manager.attachAgentPty('s2')
    first.emit('exit', { exitCode: 0 })
    // The pane is closed while its process is gone.
    manager.detachAgentPty('s2')
    await manager.recover({ sessionId: 's2', kind: 'claude', cwd: '/tmp/project' })
    second.emit('pty-data', 'nobody is watching')
    expect(forwarded).toEqual([])
  })
})

