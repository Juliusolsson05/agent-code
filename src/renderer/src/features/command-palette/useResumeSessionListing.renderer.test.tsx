import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@shared/types/session'

import { useResumeSessionListing } from './useResumeSessionListing'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const codexSession: SessionInfo = {
  sessionId: '01a0557d-f1a7-7830-bb44-e567be592195',
  summary: 'recorded Codex session',
  lastModified: 1_788_141_320_120,
  fileSize: 483_658,
  cwd: '/repo/.worktrees/codex',
}

describe('useResumeSessionListing', () => {
  it('keeps the newest provider/cwd result when restart hydration races an older request', async () => {
    const staleClaude = deferred<SessionInfo[]>()
    const listSessions = vi.fn((cwd: string) =>
      cwd === '/repo-before-hydration'
        ? staleClaude.promise
        : Promise.resolve([codexSession]),
    )
    const view = renderHook(() => useResumeSessionListing(listSessions))
    let first!: Promise<void>

    act(() => {
      first = view.result.current.load({
        cwd: '/repo-before-hydration',
        provider: 'claude',
      })
    })
    await act(async () => {
      await view.result.current.load({
        cwd: '/repo/.worktrees/codex',
        provider: 'codex',
      })
    })
    expect(view.result.current).toMatchObject({
      target: { cwd: '/repo/.worktrees/codex', provider: 'codex' },
      sessions: [codexSession],
      loading: false,
      error: null,
    })

    await act(async () => {
      staleClaude.resolve([])
      await first
    })
    expect(view.result.current).toMatchObject({
      target: { cwd: '/repo/.worktrees/codex', provider: 'codex' },
      sessions: [codexSession],
      loading: false,
      error: null,
    })
  })

  it('distinguishes a listing failure from a successful empty result', async () => {
    const listSessions = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('recorded disk read failure'))
    const view = renderHook(() => useResumeSessionListing(listSessions))

    await act(async () => {
      await view.result.current.load({ cwd: '/empty', provider: 'codex' })
    })
    expect(view.result.current.sessions).toEqual([])
    expect(view.result.current.error).toBeNull()

    await act(async () => {
      await view.result.current.load({ cwd: '/failed', provider: 'codex' })
    })
    expect(view.result.current.sessions).toEqual([])
    expect(view.result.current.error).toBe(
      'Unable to load saved sessions. Check the app log and try again.',
    )
  })
})
