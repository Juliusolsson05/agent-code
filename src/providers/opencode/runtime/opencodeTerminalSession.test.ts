import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ptyState = vi.hoisted(() => ({
  spawn: vi.fn(),
  createEmptySession: vi.fn(),
}))

vi.mock('node-pty', () => ({ spawn: ptyState.spawn }))
vi.mock('./opencodeCliSessions.js', () => ({
  createEmptyOpencodeSession: ptyState.createEmptySession,
}))

import { OpencodeTerminalSession } from './opencodeTerminalSession.js'

function fakePty() {
  let onData: ((data: string) => void) | null = null
  let onExit: ((event: { exitCode: number; signal: number }) => void) | null = null
  return {
    pid: 4321,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((listener: (data: string) => void) => { onData = listener }),
    onExit: vi.fn((listener: (event: { exitCode: number; signal: number }) => void) => {
      onExit = listener
    }),
    emitData: (data: string) => onData?.(data),
    emitExit: (event: { exitCode: number; signal: number }) => onExit?.(event),
  }
}

describe('OpencodeTerminalSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ptyState.spawn.mockReset()
    ptyState.createEmptySession.mockReset()
    ptyState.createEmptySession.mockResolvedValue('ses_created')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns the native TUI with resume, dangerous mode, and scoped MCP config', async () => {
    const pty = fakePty()
    ptyState.spawn.mockReturnValue(pty)
    const session = new OpencodeTerminalSession({
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

    expect(ptyState.spawn).toHaveBeenCalledWith(
      '/tools/opencode',
      ['--session', 'ses_123', '--auto'],
      expect.objectContaining({ cwd: '/workspace', cols: 100, rows: 30 }),
    )
    const spawnEnv = ptyState.spawn.mock.calls[0][2].env as Record<string, string>
    expect(spawnEnv.OPENCODE_CONFIG_CONTENT).toContain('{env:AGENT_CODE_MCP_0_0}')
    expect(spawnEnv.OPENCODE_CONFIG_CONTENT).not.toContain('secret')
    expect(spawnEnv.AGENT_CODE_MCP_0_0).toBe('Bearer secret')
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

  it('forwards exit once and makes repeated stop safe', async () => {
    const pty = fakePty()
    ptyState.spawn.mockReturnValue(pty)
    const session = new OpencodeTerminalSession({ cwd: '/workspace' })
    const exit = vi.fn()
    session.on('exit', exit)
    await session.start()

    expect(ptyState.createEmptySession).toHaveBeenCalledWith(expect.objectContaining({
      binary: 'opencode',
      cwd: '/workspace',
    }))
    expect(ptyState.spawn).toHaveBeenCalledWith(
      'opencode',
      ['--session', 'ses_created'],
      expect.any(Object),
    )

    pty.emitExit({ exitCode: 7, signal: 0 })
    expect(exit).toHaveBeenCalledWith({ exitCode: 7, signal: 0 })
    expect(session.isExited()).toBe(true)
    await session.stop()
    await session.stop()
    expect(pty.kill).not.toHaveBeenCalled()
  })

  it('does not inject an orchestration prompt before the native TUI paints', async () => {
    const pty = fakePty()
    ptyState.spawn.mockReturnValue(pty)
    const session = new OpencodeTerminalSession({ cwd: '/workspace' })
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
    const session = new OpencodeTerminalSession({ cwd: '/workspace' })

    const starting = session.start()
    await vi.waitFor(() => expect(ptyState.createEmptySession).toHaveBeenCalledOnce())
    await session.stop()
    finishImport('ses_late')
    await starting

    expect(ptyState.spawn).not.toHaveBeenCalled()
    expect(session.isExited()).toBe(true)
  })
})
