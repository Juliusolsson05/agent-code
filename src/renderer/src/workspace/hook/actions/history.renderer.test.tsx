import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import { useHistoryActions } from './history'

// The mapper's filtering/marker contract is the boundary under test: cursor
// selection must not assume marker uniqueness or that every raw line renders.
vi.mock('@providers/registry.renderer.capabilities', () => ({
  getRendererProviderCapabilities: () => ({
    createTranscriptEntryMapper: () => ({ map: (raw: unknown) => raw }),
  }),
}))

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function ref<T>(current: T): MutableRefObject<T> { return { current } }

describe('older history position cursor', () => {
  it.each([
    { laterMarker: 'different', offsets: [50, 100, 200], expectedOffset: 100 },
    { laterMarker: 'anchor', offsets: [50, 100, 200], expectedOffset: 100 },
    { laterMarker: 'different', offsets: undefined, expectedOffset: null },
  ])('pins the first renderable line when markers repeat ($laterMarker, $expectedOffset)', async ({ laterMarker, offsets, expectedOffset }) => {
    let runtimes: Record<string, SessionRuntime> = {
      session: { ...emptyRuntime(), hasOlderHistory: true, historyOldestMarker: 'anchor', historyOldestOffset: 900 },
    }
    const refs = {
      stateRef: ref({ sessions: { session: { kind: 'claude', cwd: '/tmp/project', providerSessionId: 'provider-session' } } }),
      latestRuntimesRef: ref(runtimes),
      seenUuidsRef: ref({}),
    } as unknown as WorkspaceRefs
    const setRuntimes: WorkspaceSetRuntimes = next => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
      refs.latestRuntimesRef.current = runtimes
    }
    const updateRuntime = (id: string, patch: Partial<SessionRuntime>) => {
      setRuntimes(prev => ({ ...prev, [id]: { ...prev[id]!, ...patch } }))
    }
    const entry = (uuid: string) => ({ type: 'user', uuid, message: { role: 'user', content: uuid } })
    const loadOlderHistory = vi.fn()
      .mockResolvedValueOnce({
        entries: [
          { entries: [], historyMarker: 'metadata' },
          { entries: [entry('older-1')], historyMarker: 'anchor' },
          { entries: [entry('older-2')], historyMarker: laterMarker },
        ],
        offsets,
        hasMore: true,
      })
      .mockResolvedValueOnce({ entries: [], hasMore: false })
    Object.defineProperty(window, 'api', { configurable: true, value: {
      loadOlderHistory, gitWorktrees: vi.fn(async () => ({ ok: true, worktrees: [] })),
    } })
    const { result } = renderHook(() => useHistoryActions(setRuntimes, refs, updateRuntime))
    await act(async () => { await result.current.loadOlderHistory('session') })
    expect(runtimes.session).toMatchObject({ historyOldestMarker: 'anchor', historyOldestOffset: expectedOffset, loadingOlderHistory: false })
    await act(async () => { await result.current.loadOlderHistory('session') })
    expect(loadOlderHistory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      beforeMarker: 'anchor', beforeOffset: expectedOffset ?? undefined,
    }))
    expect(runtimes.session?.hasOlderHistory).toBe(false)
  })
})
