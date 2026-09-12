import { describe, expect, it, vi } from 'vitest'

import type { TerminalForegroundSample, TerminalForegroundState } from '@shared/types/terminalForeground.js'
import {
  TerminalForegroundMonitor,
  classifyForeground,
  normalizeForegroundCommand,
} from './terminalForeground.js'

// The monitor is the only producer of shell activity (#865). These tests pin
// the three properties that make a 1 s poll safe to run for the app's whole
// life: it only exists while terminals do, it never overlaps itself (the
// 2026-07-07 OOM was a poll without that guard), and it only speaks on change.

function harness(options: {
  panes?: () => Promise<ReadonlyMap<string, TerminalForegroundSample>>
  direct?: Record<string, string | null>
} = {}) {
  const changes: Array<[string, TerminalForegroundState]> = []
  const timers: Array<() => void> = []
  const cleared: unknown[] = []
  const listTmuxPanes = vi.fn(options.panes ?? (async () => new Map()))
  const direct = options.direct ?? {}
  const monitor = new TerminalForegroundMonitor({
    listTmuxPanes,
    sampleDirect: sessionId => (sessionId in direct ? { command: direct[sessionId], cwd: null } : null),
    onChange: (sessionId, state) => changes.push([sessionId, state]),
    setTimer: fn => { timers.push(fn); return timers.length },
    clearTimer: handle => { cleared.push(handle) },
  })
  return { monitor, changes, timers, cleared, listTmuxPanes, direct }
}

describe('classifyForeground', () => {
  it('reads a shell at its prompt as idle and anything else as busy', () => {
    expect(classifyForeground({ command: 'zsh', cwd: '/w' })).toEqual({ busy: false, command: 'zsh', cwd: '/w' })
    expect(classifyForeground({ command: '-zsh', cwd: null })).toEqual({ busy: false, command: 'zsh', cwd: null })
    expect(classifyForeground({ command: 'npm', cwd: '/w' })).toEqual({ busy: true, command: 'npm', cwd: '/w' })
    expect(classifyForeground({ command: '/usr/bin/vim', cwd: '' })).toEqual({ busy: true, command: 'vim', cwd: null })
  })

  it('treats an unknown foreground as idle rather than busy', () => {
    // A lit header must be a claim we can back; "no idea" is not "working".
    expect(classifyForeground({ command: null, cwd: null }).busy).toBe(false)
    expect(normalizeForegroundCommand('   ')).toBeNull()
  })
})

describe('TerminalForegroundMonitor', () => {
  it('does not poll until a terminal is tracked, and stops with the last one', () => {
    const { monitor, timers, cleared } = harness()
    expect(timers).toHaveLength(0)
    monitor.track('a', { kind: 'direct' })
    monitor.track('b', { kind: 'direct' })
    expect(timers).toHaveLength(1)
    monitor.untrack('a')
    expect(cleared).toHaveLength(0)
    monitor.untrack('b')
    expect(cleared).toHaveLength(1)
  })

  it('emits only when the classified state changes', async () => {
    const { monitor, changes, direct } = harness({ direct: { a: 'zsh' } })
    monitor.track('a', { kind: 'direct' })
    await monitor.tick()
    await monitor.tick()
    direct.a = 'npm'
    await monitor.tick()
    await monitor.tick()
    expect(changes).toEqual([
      ['a', { busy: false, command: 'zsh', cwd: null }],
      ['a', { busy: true, command: 'npm', cwd: null }],
    ])
  })

  it('never runs two ticks at once', async () => {
    let release!: () => void
    const pending = new Promise<ReadonlyMap<string, TerminalForegroundSample>>(resolve => {
      release = () => resolve(new Map([['agentcode-1', { command: 'vim', cwd: '/w' }]]))
    })
    const { monitor, listTmuxPanes, changes } = harness({ panes: () => pending })
    monitor.track('a', { kind: 'tmux', tmuxName: 'agentcode-1' })
    const first = monitor.tick()
    await monitor.tick()
    expect(listTmuxPanes).toHaveBeenCalledTimes(1)
    release()
    await first
    expect(changes).toEqual([['a', { busy: true, command: 'vim', cwd: '/w' }]])
  })

  it('keeps the last state when tmux cannot be read instead of flapping to idle', async () => {
    let fail = false
    const { monitor, changes } = harness({
      panes: async () => {
        if (fail) throw new Error('server exited')
        return new Map([['agentcode-1', { command: 'node', cwd: '/w' }]])
      },
    })
    monitor.track('a', { kind: 'tmux', tmuxName: 'agentcode-1' })
    await monitor.tick()
    fail = true
    await monitor.tick()
    expect(changes).toHaveLength(1)
    expect(monitor.snapshot()).toEqual({ a: { busy: true, command: 'node', cwd: '/w' } })
  })

  it('does not spawn tmux when only direct terminals are tracked', async () => {
    const { monitor, listTmuxPanes } = harness({ direct: { a: 'zsh' } })
    monitor.track('a', { kind: 'direct' })
    await monitor.tick()
    expect(listTmuxPanes).not.toHaveBeenCalled()
  })

  it('reports a direct terminal even while a tmux listing is still pending (M1)', async () => {
    // listTmuxPanes never resolves — standing in for a hung/wedged tmux
    // server. Before M1 the single combined loop ran only AFTER the tmux
    // await, so a stalled tmux listing delayed every direct-PTY terminal's
    // foreground update too, even though direct sampling has nothing to do
    // with tmux. The fix samples direct sessions first and unconditionally,
    // so 'a' must report even though the tmux half of this very tick never
    // completes (and never will, for the life of this test).
    const neverResolves = new Promise<ReadonlyMap<string, TerminalForegroundSample>>(() => {})
    const { monitor, changes } = harness({ panes: () => neverResolves, direct: { a: 'npm' } })
    monitor.track('a', { kind: 'direct' })
    monitor.track('b', { kind: 'tmux', tmuxName: 'agentcode-1' })
    // Deliberately not awaited: tick() suspends forever at the tmux await,
    // so awaiting it here would hang the test. The direct half of the loop
    // runs synchronously before that suspension point, so it has already
    // happened by the time this call returns a pending promise.
    void monitor.tick()
    expect(changes).toEqual([['a', { busy: true, command: 'npm', cwd: null }]])
  })

  it('forgets state on untrack so a re-tracked session reports again', async () => {
    const { monitor, changes } = harness({ direct: { a: 'zsh' } })
    monitor.track('a', { kind: 'direct' })
    await monitor.tick()
    monitor.untrack('a')
    expect(monitor.snapshot()).toEqual({})
    monitor.track('a', { kind: 'direct' })
    await monitor.tick()
    expect(changes).toHaveLength(2)
  })
})
