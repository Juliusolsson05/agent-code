import { act, renderHook } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { WorkspaceState } from '@renderer/workspace/types'

import { useAutoSave } from './useAutoSave'

vi.mock('@renderer/performance/client', () => ({
  span: () => ({ end: vi.fn(), fail: vi.fn() }),
}))

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

describe('workspace autosave durability retry', () => {
  it('retries a rejected ownership save without requiring another state mutation', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const state: WorkspaceState = {
      tabs: [{
        id: 'tab-a',
        title: 'recorded',
        root: { type: 'leaf', sessionId: 'successor' },
        focusedSessionId: 'successor',
      }],
      activeTabId: 'tab-a',
      dispatchMode: null,
      sessions: {
        successor: { cwd: '/recorded/worktree', kind: 'codex' },
      },
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
    }
    const refs = {
      latestStateRef: ref(state),
      latestRuntimesRef: ref({ successor: emptyRuntime() }),
      latestTileTabsRef: ref(null),
      saveTimerRef: ref<ReturnType<typeof setTimeout> | null>(null),
    } as unknown as WorkspaceRefs
    const saveWorkspace = vi.fn()
      .mockRejectedValueOnce(new Error('recorded atomic save rejection'))
      .mockResolvedValueOnce(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { saveWorkspace },
    })

    const { unmount } = renderHook(() => useAutoSave(state, 0, refs, true))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(saveWorkspace).toHaveBeenCalledTimes(1)

    // The pending main reservation is released only by a successful atomic
    // save acknowledgement. A one-shot debounce makes a transient disk error
    // permanent until an unrelated UI edit; the retry must come from the save
    // lifecycle itself and serialize the latest ref-backed workspace state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(saveWorkspace).toHaveBeenCalledTimes(2)
    expect(JSON.parse(saveWorkspace.mock.calls[1][0])).toMatchObject({
      workspace: { sessions: { successor: { kind: 'codex' } } },
    })

    unmount()
  })

  it('retries a failed unload flush when another guard vetoes the unload', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const state: WorkspaceState = {
      tabs: [{
        id: 'tab-a',
        title: 'recorded',
        root: { type: 'leaf', sessionId: 'successor' },
        focusedSessionId: 'successor',
      }],
      activeTabId: 'tab-a',
      dispatchMode: null,
      sessions: {
        successor: { cwd: '/recorded/worktree', kind: 'codex' },
      },
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
    }
    const refs = {
      latestStateRef: ref(state),
      latestRuntimesRef: ref({ successor: emptyRuntime() }),
      latestTileTabsRef: ref(null),
      saveTimerRef: ref<ReturnType<typeof setTimeout> | null>(null),
    } as unknown as WorkspaceRefs
    const saveWorkspace = vi.fn()
      .mockRejectedValueOnce(new Error('recorded vetoed-unload save rejection'))
      .mockResolvedValueOnce(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { saveWorkspace },
    })
    const { unmount } = renderHook(() => useAutoSave(state, 0, refs, true))
    const vetoUnload = (event: Event): void => event.preventDefault()
    window.addEventListener('beforeunload', vetoUnload)

    await act(async () => {
      const accepted = window.dispatchEvent(new Event('beforeunload', {
        cancelable: true,
      }))
      expect(accepted).toBe(false)
      await Promise.resolve()
    })
    expect(saveWorkspace).toHaveBeenCalledTimes(1)

    // The editor's real beforeunload guard can keep this renderer mounted. The
    // attempted unload is therefore not teardown evidence: if its one save
    // fails, the pending P→S durability transaction still needs a retry to wake
    // an already-queued S→T request.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(saveWorkspace).toHaveBeenCalledTimes(2)

    window.removeEventListener('beforeunload', vetoUnload)
    unmount()
  })

  it('backs off persistent failures and cancels the retry owned by unmount', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const state: WorkspaceState = {
      tabs: [{
        id: 'tab-a',
        title: 'recorded',
        root: { type: 'leaf', sessionId: 'successor' },
        focusedSessionId: 'successor',
      }],
      activeTabId: 'tab-a',
      dispatchMode: null,
      sessions: {
        successor: { cwd: '/recorded/worktree', kind: 'codex' },
      },
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
    }
    const refs = {
      latestStateRef: ref(state),
      latestRuntimesRef: ref({ successor: emptyRuntime() }),
      latestTileTabsRef: ref(null),
      saveTimerRef: ref<ReturnType<typeof setTimeout> | null>(null),
    } as unknown as WorkspaceRefs
    const saveWorkspace = vi.fn().mockRejectedValue(
      new Error('recorded persistent save rejection'),
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { saveWorkspace },
    })
    const { unmount } = renderHook(() => useAutoSave(state, 0, refs, true))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
      await vi.advanceTimersByTimeAsync(400)
      await vi.advanceTimersByTimeAsync(799)
    })
    expect(saveWorkspace).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(saveWorkspace).toHaveBeenCalledTimes(3)

    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(saveWorkspace).toHaveBeenCalledTimes(3)
  })
})
