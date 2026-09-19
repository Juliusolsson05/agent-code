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

  it('routes Jump to Latest to a provider that can scroll its own view, and says unsupported otherwise (#843)', async () => {
    const { SessionManager } = await import('./sessionManager')
    const manager = new SessionManager()
    const plain = new FakeAgentSession()
    createSession.mockImplementationOnce(() => plain)
    const { sessionId: plainId } = await manager.spawn({ kind: 'claude', cwd: '/tmp/project' })
    expect(await manager.jumpToLatest(plainId)).toEqual({ ok: false, reason: 'unsupported' })

    const jumper = Object.assign(new FakeAgentSession(), { jumpToLatest: vi.fn(async () => ({ ok: true as const })) })
    createSession.mockImplementationOnce(() => jumper)
    const { sessionId: jumperId } = await manager.spawn({ kind: 'claude', cwd: '/tmp/project' })
    expect(await manager.jumpToLatest(jumperId)).toEqual({ ok: true })
    expect(jumper.jumpToLatest).toHaveBeenCalledTimes(1)
    expect(await manager.jumpToLatest('missing')).toEqual({ ok: false, reason: 'no-session' })
    await manager.kill(plainId)
    await manager.kill(jumperId)
  })

  it('a remounted raw terminal gets the modes its evicted startup bytes set (#843, real OpenCode recording)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { Terminal } = await import('@xterm/headless')
    const recording = JSON.parse(readFileSync(resolve(__dirname, '../../testing/fixtures/terminal-replay-modes/opencode-1.18.31-startup.json'), 'utf8')) as Array<{ d: string }>
    const preamble = recording.findIndex(chunk => chunk.d.includes('\x1b[?1049h'))
    const frames = recording.slice(preamble + 1).map(chunk => chunk.d).filter(chunk => chunk.includes('\x1b[?2026h'))
    const { SessionManager } = await import('./sessionManager')
    const session = new FakeAgentSession()
    createSession.mockImplementation(() => session)
    const manager = new SessionManager()
    const { sessionId } = await manager.spawn({ kind: 'claude', cwd: '/tmp/project' })
    for (const chunk of recording.slice(0, preamble + 1)) session.emit('pty-data', chunk.d)
    // Past the real 512 KiB agent cap, as minutes of 60 fps repaint are.
    let written = 0
    while (written < 600 * 1024) for (const frame of frames) { session.emit('pty-data', frame); written += frame.length }
    const replay = manager.attachAgentPty(sessionId)!
    const terminal = new Terminal({ cols: 120, rows: 36, allowProposedApi: true })
    await new Promise<void>(done => terminal.write(replay, done))
    expect(terminal.buffer.active.type).toBe('alternate')
    expect(terminal.modes.mouseTrackingMode).toBe('any')
    manager.detachAgentPty(sessionId)
    await manager.kill(sessionId)
  })
})

