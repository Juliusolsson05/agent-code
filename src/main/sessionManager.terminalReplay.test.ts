import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

// #843 / #1041 review: the SHELL attach path (attachTerminal) must replay the
// modes its evicted bytes set, like the agent path. Reverting it to read()
// passed every test until this one. A full-screen program run from a shell
// (vim, htop, an OpenCode TUI started by hand) sets the alternate screen and
// mouse tracking once; 256 KiB of repaint evicts that.
const terminals = vi.hoisted(() => ({ latest: null as null | EventEmitter }))
vi.mock('@shared/runtime/terminalSession.js', () => ({
  TerminalSession: class FakeTerminalSession extends EventEmitter {
    constructor() { super(); terminals.latest = this }
    async start(): Promise<void> { this.emit('started') }
    async stop(): Promise<void> {}
    write(): void {}
    resize(): void {}
  },
}))
vi.mock('@main/workspaceDirectory.js', () => ({
  MissingWorkspaceDirectoryError: class extends Error {},
  assertWorkspaceDirectoryExists: vi.fn(async () => {}),
}))
vi.mock('@main/setup/toolchain.js', () => ({ getToolPath: () => '/usr/bin/true' }))
vi.mock('@main/performance/PerformanceService.js', () => ({
  performanceService: { mark: vi.fn(), record: vi.fn(), error: vi.fn(), metric: vi.fn(), span: () => ({ end: vi.fn(), fail: vi.fn() }) },
}))
vi.mock('@main/storage/feedDebugLog.js', () => ({ forgetFeedDebugSession: vi.fn() }))

it('a remounted shell terminal gets the alternate screen and mouse mode its evicted bytes set', async () => {
  const { Terminal } = await import('@xterm/headless')
  const { SessionManager } = await import('./sessionManager')
  // No tmux: a direct PTY terminal, the case every machine without tmux runs.
  const manager = new SessionManager({ isAvailable: () => false, getBinary: () => null } as never)
  const { sessionId } = await manager.spawn({ kind: 'terminal', cwd: '/tmp/project' })
  const shell = terminals.latest!
  shell.emit('data', 'user@host project % vim notes.md\r\n')
  shell.emit('data', '\x1b[?1049h\x1b[?1000h\x1b[?1006h')
  // Past the 256 KiB shell cap with full-screen repaints.
  const frame = '\x1b[H' + 'editing notes '.repeat(200) + '\r\n'
  for (let written = 0; written < 300 * 1024; written += frame.length) shell.emit('data', frame)

  const replay = manager.attachTerminal(sessionId)
  const terminal = new Terminal({ cols: 120, rows: 36, allowProposedApi: true })
  await new Promise<void>(done => terminal.write(replay, done))
  expect(terminal.buffer.active.type).toBe('alternate')
  expect(terminal.modes.mouseTrackingMode).toBe('vt200')
  await manager.kill(sessionId)
})
