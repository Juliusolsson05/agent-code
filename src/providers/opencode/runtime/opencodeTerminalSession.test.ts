import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpencodeTerminalLaunch } from 'opencode-terminal-headless'

const ptyState = vi.hoisted(() => ({
  spawn: vi.fn(),
  createEmptySession: vi.fn(),
}))

// WHY node-pty is still mocked although the spawn is injected: the adapter
// imports node-pty at module level, and Agent Code's copy is rebuilt for
// Electron's ABI (postinstall electron-rebuild), so it cannot load under the
// plain-Node test runner at all.
vi.mock('node-pty', () => ({ spawn: ptyState.spawn }))
vi.mock('./opencodeCliSessions.js', () => ({
  createEmptyOpencodeSession: ptyState.createEmptySession,
}))

import { OpencodeTerminalSession } from './opencodeTerminalSession.js'

// Unit coverage of the adapter's own responsibilities: session identity, MCP
// launch config, the launch contract, readiness and prompt delivery, exit and
// stop. The reader behind it is the real opencode-terminal-headless package;
// only the PTY spawn and the launch step are replaced, so no real TUI, port or
// `opencode` binary is involved. The recorded end-to-end mapping lives in
// opencodeTerminalSession.system.test.ts.

function fakePty() {
  let onData: ((data: string) => void) | null = null
  const exitListeners: Array<(event: { exitCode: number; signal: number }) => void> = []
  return {
    pid: 4321,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((listener: (data: string) => void) => { onData = listener }),
    onExit: vi.fn((listener: (event: { exitCode: number; signal: number }) => void) => {
      exitListeners.push(listener)
      return { dispose: () => exitListeners.splice(exitListeners.indexOf(listener), 1) }
    }),
    emitData: (data: string) => onData?.(data),
    emitExit: (event: { exitCode: number; signal: number }) => [...exitListeners].forEach(listener => listener(event)),
  }
}

// A launch whose server nobody listens on and whose database is unavailable:
// the adapter under test must not depend on either channel being healthy.
function fakePrepareLaunch() {
  return vi.fn(async (opts: { binary: string; cwd: string; env: Record<string, string>; sessionID: string; dangerousMode: boolean }): Promise<OpencodeTerminalLaunch> => ({
    binary: opts.binary,
    args: ['--session', opts.sessionID, '--hostname', '127.0.0.1', '--port', '1', ...(opts.dangerousMode ? ['--auto'] : [])],
    env: { ...opts.env, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: 'pw' },
    sessionID: opts.sessionID,
    server: { url: 'http://127.0.0.1:1', username: 'opencode', password: 'pw' },
    dbPath: null,
    dbPathError: 'not resolved in unit tests',
  }))
}

const sessions: OpencodeTerminalSession[] = []

function create(options: ConstructorParameters<typeof OpencodeTerminalSession>[0], prepareLaunch = fakePrepareLaunch()) {
  const session = new OpencodeTerminalSession(options, {
    spawnPty: ptyState.spawn,
    prepareLaunch,
    headlessOptions: { liveConnectDeadlineMs: 60_000, heartbeatMs: 0 },
  })
  sessions.push(session)
  return { session, prepareLaunch }
}

describe('OpencodeTerminalSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ptyState.spawn.mockReset()
    ptyState.createEmptySession.mockReset()
    ptyState.createEmptySession.mockResolvedValue('ses_created')
  })

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.stop()
    vi.useRealTimers()
  })

  it('launches the observable TUI with resume, dangerous mode, and scoped MCP config', async () => {
    const pty = fakePty()
    ptyState.spawn.mockReturnValue(pty)
    const { session, prepareLaunch } = create({
      cwd: '/workspace',
      cols: 100,
      rows: 30,
      binary: '/tools/opencode',
      resumeSessionId: 'ses_123',
      dangerousMode: true,
      builtInMcpServers: [{
        name: 'agent-code',
        url: 'http://127.0.0.1:9000/mcp',
        bearerToken: 'secret',
        headers: {},
      }],
    })
    const output = vi.fn()
    const identity = vi.fn()
    session.on('pty-data', output)
    session.on('jsonl-entry', identity)

    await session.start()

    // The launch step receives the resumed id and the provider-neutral
    // dangerous mode; the adapter spawns exactly what it returns.
    expect(prepareLaunch).toHaveBeenCalledWith(expect.objectContaining({
      binary: '/tools/opencode',
      cwd: '/workspace',
      sessionID: 'ses_123',
      dangerousMode: true,
    }))
    expect(ptyState.spawn).toHaveBeenCalledWith(
      '/tools/opencode',
      ['--session', 'ses_123', '--hostname', '127.0.0.1', '--port', '1', '--auto'],
      expect.objectContaining({ cwd: '/workspace', cols: 100, rows: 30 }),
    )
    const spawnEnv = ptyState.spawn.mock.calls[0][2].env as Record<string, string>
    expect(spawnEnv.OPENCODE_CONFIG_CONTENT).toContain('{env:AGENT_CODE_MCP_0_0}')
    expect(spawnEnv.OPENCODE_CONFIG_CONTENT).not.toContain('secret')
    expect(spawnEnv.AGENT_CODE_MCP_0_0).toBe('Bearer secret')
    expect(spawnEnv.OPENCODE_SERVER_PASSWORD).toBe('pw')
    expect(ptyState.createEmptySession).not.toHaveBeenCalled()
    expect(identity).toHaveBeenCalledWith(
      { sessionID: 'ses_123' },
      'opencode://session/ses_123',
    )

    pty.emitData('\x1b[2JOpenCode')
    expect(output).toHaveBeenCalledWith('\x1b[2JOpenCode')

    const delivery = session.deliverPromptText('one\ntwo')
    expect(pty.write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    await delivery
    expect(pty.write).toHaveBeenCalledWith('\x1b[200~one\ntwo\x1b[201~\r')
  })

  it('reports a disabled durable channel instead of failing the pane', async () => {
    const pty = fakePty()
    ptyState.spawn.mockReturnValue(pty)
    const { session } = create({ cwd: '/workspace' })
    const errors: Error[] = []
    const started = vi.fn()
    session.on('jsonl-error', error => errors.push(error))
    session.on('started', started)
    await session.start()
    expect(started).toHaveBeenCalledOnce()
    expect(errors.map(error => (error as Error & { code?: string }).code)).toEqual(['db_path_unavailable'])
  })

  it('forwards exit once, after the reader closed the turn, and makes repeated stop safe', async () => {
    const pty = fakePty()
    ptyState.spawn.mockReturnValue(pty)
    const { session } = create({ cwd: '/workspace' })
    const exit = vi.fn()
    const processState = vi.fn()
    session.on('exit', exit)
    session.on('process-state', processState)
    await session.start()

    expect(ptyState.createEmptySession).toHaveBeenCalledWith(expect.objectContaining({
      binary: 'opencode',
      cwd: '/workspace',
    }))
    expect(ptyState.spawn).toHaveBeenCalledWith(
      'opencode',
      ['--session', 'ses_created', '--hostname', '127.0.0.1', '--port', '1'],
      expect.any(Object),
    )

    pty.emitExit({ exitCode: 7, signal: 0 })
    expect(exit).toHaveBeenCalledWith({ exitCode: 7, signal: 0 })
    expect(exit).toHaveBeenCalledOnce()
    expect(processState).toHaveBeenLastCalledWith({ active: false })
    expect(session.isExited()).toBe(true)
    await session.stop()
    await session.stop()
    expect(pty.kill).not.toHaveBeenCalled()
  })

  it('does not inject an orchestration prompt before the native TUI paints', async () => {
    const pty = fakePty()
    ptyState.spawn.mockReturnValue(pty)
    const { session } = create({ cwd: '/workspace' })
    await session.start()

    const delivery = session.deliverPromptText('too early')
    const rejected = expect(delivery).rejects.toThrow('did not become ready')
    await vi.advanceTimersByTimeAsync(15_000)

    await rejected
    expect(pty.write).not.toHaveBeenCalled()
  })

  it('does not spawn a TUI when stop wins during empty-session import', async () => {
    let finishImport!: (sessionId: string) => void
    ptyState.createEmptySession.mockReturnValue(new Promise<string>(resolve => {
      finishImport = resolve
    }))
    const { session, prepareLaunch } = create({ cwd: '/workspace' })

    const starting = session.start()
    await vi.waitFor(() => expect(ptyState.createEmptySession).toHaveBeenCalledOnce())
    await session.stop()
    finishImport('ses_late')
    await starting

    expect(prepareLaunch).not.toHaveBeenCalled()
    expect(ptyState.spawn).not.toHaveBeenCalled()
    expect(session.isExited()).toBe(true)
  })

  it('kills the TUI and silences the reader on stop', async () => {
    const pty = fakePty()
    ptyState.spawn.mockReturnValue(pty)
    const { session } = create({ cwd: '/workspace' })
    const exit = vi.fn()
    session.on('exit', exit)
    await session.start()
    await session.stop()
    expect(pty.kill).toHaveBeenCalledOnce()
    // node-pty reports the kill as an exit; a stopped wrapper forwards nothing.
    pty.emitExit({ exitCode: 0, signal: 15 })
    expect(exit).not.toHaveBeenCalled()
  })
})
