import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

// #1281 (terminal half): a mounted TerminalLeaf attaches once per session id,
// but process cleanup cleared the attach when the shell exited. A same-id
// respawn under the still-mounted leaf (recover from a delivery, a control
// call, a wake) then buffered the new shell's bytes and never forwarded them:
// the xterm stayed on the dead shell until a remount. The agent half of the
// same bug is sessionManager.ptyAttachWake.test.ts.
const terminals = vi.hoisted(() => ({ created: [] as EventEmitter[] }))
vi.mock('@shared/runtime/terminalSession.js', () => ({
  TerminalSession: class FakeTerminalSession extends EventEmitter {
    constructor() { super(); terminals.created.push(this) }
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

// Imported once at module scope (#1333 review a): a cold import of the
// manager's graph took ~4 s inside the first test and hit the default 5 s
// timeout on a contended machine. Collection time is not test time.
const { SessionManager } = await import('./sessionManager')

async function managerWithShell() {
  // No tmux: a direct PTY terminal, the case every machine without tmux runs.
  const manager = new SessionManager({ isAvailable: () => false, getBinary: () => null } as never)
  const forwarded: string[] = []
  manager.on('terminal-data', event => forwarded.push(event.data))
  const { sessionId } = await manager.spawn({ kind: 'terminal', cwd: '/tmp/project' })
  return { manager, forwarded, sessionId }
}

it('keeps forwarding to a still-attached terminal view after its shell exits and respawns under the same id', async () => {
  const { manager, forwarded, sessionId } = await managerWithShell()
  manager.attachTerminal(sessionId)
  const first = terminals.created.at(-1)!
  first.emit('data', 'old shell')
  first.emit('exit', { exitCode: 0 })

  await manager.recover({ sessionId, kind: 'terminal', cwd: '/tmp/project' })
  const second = terminals.created.at(-1)!
  expect(second).not.toBe(first)
  second.emit('data', 'fresh shell')
  expect(forwarded).toEqual(['old shell', 'fresh shell'])

  // The view's own detach still ends forwarding.
  manager.detachTerminal(sessionId)
  second.emit('data', 'after detach')
  expect(forwarded).not.toContain('after detach')
  await manager.kill(sessionId)
})

it('forgets the view when the pane detaches while its shell is down', async () => {
  const { manager, forwarded, sessionId } = await managerWithShell()
  manager.attachTerminal(sessionId)
  terminals.created.at(-1)!.emit('exit', { exitCode: 0 })
  manager.detachTerminal(sessionId)
  await manager.recover({ sessionId, kind: 'terminal', cwd: '/tmp/project' })
  terminals.created.at(-1)!.emit('data', 'nobody is watching')
  expect(forwarded).toEqual([])
  await manager.kill(sessionId)
})

// Two views of one shell in the same renderer (a lane and a retained
// Spotlight copy): one closing must not cut the other off. Two WINDOWS cannot
// both receive a shell's bytes: the window router gives a session one owner
// (#1333 review c), so this is about views within the receiving renderer.
it('keeps forwarding while any view of the shell is still attached', async () => {
  const { manager, forwarded, sessionId } = await managerWithShell()
  manager.attachTerminal(sessionId)
  manager.attachTerminal(sessionId)
  manager.detachTerminal(sessionId)
  terminals.created.at(-1)!.emit('data', 'still watched')
  expect(forwarded).toEqual(['still watched'])
  await manager.kill(sessionId)
})

// #1333 review (a, b, c; surviving mutant): a leaf can attach while its shell
// is down (it exited between the leaf's wake and its attach reaching main).
// That attach must still take a reference, or the same-id respawn buffers its
// bytes and the leaf stays frozen: the bug this file is about, one step
// earlier.
it('forwards a respawned shell to a view that attached while the shell was down', async () => {
  const { manager, forwarded, sessionId } = await managerWithShell()
  terminals.created.at(-1)!.emit('exit', { exitCode: 0 })
  expect(manager.attachTerminal(sessionId)).toBe('')
  await manager.recover({ sessionId, kind: 'terminal', cwd: '/tmp/project' })
  terminals.created.at(-1)!.emit('data', 'after absent attach')
  expect(forwarded).toEqual(['after absent attach'])
  await manager.kill(sessionId)
})
