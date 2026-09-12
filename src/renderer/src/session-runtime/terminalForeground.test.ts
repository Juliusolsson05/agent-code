import { describe, expect, it } from 'vitest'

import { emptyRuntime } from './state'
import { applyTerminalForeground } from './terminalForeground'

// The renderer half of #865: one observation from main becomes the same
// runtime fields an agent's spinner produces, so Status Mode, tab counts, the
// close confirmation and Dispatch need no terminal-specific code at all.

const idle = { busy: false, command: 'zsh', cwd: '/work/api' }
const busy = { busy: true, command: 'npm', cwd: '/work/api' }

describe('applyTerminalForeground', () => {
  it('reads a busy foreground as running, with the command as the activity', () => {
    const next = applyTerminalForeground(emptyRuntime(), busy, 1_000)
    expect(next).toMatchObject({
      sessionStatus: 'running',
      processActive: true,
      activityStatus: 'npm',
      terminalForeground: { ...busy, changedAt: 1_000 },
    })
  })

  it('returns the same object for a repeated observation', () => {
    const once = applyTerminalForeground(emptyRuntime(), busy, 1_000)
    expect(applyTerminalForeground(once, busy, 2_000)).toBe(once)
  })

  it('marks the session unread when a command finishes, not when one starts', () => {
    const started = applyTerminalForeground(emptyRuntime(), busy, 1_000)
    expect(started.unreadKind).toBeNull()
    const finished = applyTerminalForeground(started, idle, 5_000)
    expect(finished).toMatchObject({ sessionStatus: 'idle', unreadKind: 'output', unreadSince: 5_000 })
  })

  it('never downgrades an attention marker to plain output', () => {
    const started = { ...applyTerminalForeground(emptyRuntime(), busy, 1_000), unreadKind: 'attention' as const, unreadSince: 500 }
    expect(applyTerminalForeground(started, idle, 5_000)).toMatchObject({ unreadKind: 'attention', unreadSince: 500 })
  })

  it('records a cd as activity without marking anything unread', () => {
    const atPrompt = applyTerminalForeground(emptyRuntime(), idle, 1_000)
    const moved = applyTerminalForeground(atPrompt, { ...idle, cwd: '/work/web' }, 3_000)
    expect(moved.terminalForeground).toEqual({ ...idle, cwd: '/work/web', changedAt: 3_000 })
    expect(moved.unreadKind).toBeNull()
  })

  it('keeps an exited terminal exited', () => {
    const exited = { ...emptyRuntime(), exited: 0, sessionStatus: 'exited' as const }
    expect(applyTerminalForeground(exited, busy, 1_000).sessionStatus).toBe('exited')
  })
})
