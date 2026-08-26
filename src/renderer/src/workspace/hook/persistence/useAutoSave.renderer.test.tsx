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
})
