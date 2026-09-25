import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import { sessionActivity } from '@renderer/session-runtime/activity'
import { useHistoryActions } from './history'
// The desktop feed, which reads through the `window.api` stubs installed below.
import { ipcSessionFeed } from '@renderer/features/sessionFeed/IpcSessionFeed'

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
    const { result } = renderHook(() => useHistoryActions(setRuntimes, refs, updateRuntime, ipcSessionFeed))
    await act(async () => { await result.current.loadOlderHistory('session') })
    expect(runtimes.session).toMatchObject({ historyOldestMarker: 'anchor', historyOldestOffset: expectedOffset, loadingOlderHistory: false })
    await act(async () => { await result.current.loadOlderHistory('session') })
    expect(loadOlderHistory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      beforeMarker: 'anchor', beforeOffset: expectedOffset ?? undefined,
    }))
    expect(runtimes.session?.hasOlderHistory).toBe(false)
  })
})

describe('older history and the ingest watermark (#915)', () => {
  it('populates entries while leaving lastJsonlEntryAt null, which is what makes the tail fallback reachable', async () => {
    // `sessionActivity` falls back to the newest entry's own timestamp when
    // `lastJsonlEntryAt` is null, and its WHY claims that state is REACHABLE
    // rather than merely constructible. This is the path: the initial load is
    // the only writer of the watermark, so a first chunk whose lines are all
    // non-renderable metadata maps to zero entries and leaves it null — and
    // this prepend, the older page that then supplies real entries, never
    // touches it. Common in the corpus: 351 of 500 local Claude transcripts
    // end on a `cost-state` row.
    //
    // Asserted here rather than in lastActiveAgreement.test.ts because it is a
    // fact about THIS reducer; a hand-built runtime would only restate the
    // assumption.
    let runtimes: Record<string, SessionRuntime> = {
      session: { ...emptyRuntime(), hasOlderHistory: true, historyOldestMarker: 'anchor' },
    }
    expect(runtimes.session?.lastJsonlEntryAt).toBeNull()
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
    const older = {
      type: 'assistant',
      uuid: 'older-1',
      timestamp: '2026-09-20T09:05:00.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] },
    }
    Object.defineProperty(window, 'api', { configurable: true, value: {
      loadOlderHistory: vi.fn().mockResolvedValue({
        entries: [{ entries: [older], historyMarker: 'older-1' }],
        hasMore: false,
      }),
      gitWorktrees: vi.fn(async () => ({ ok: true, worktrees: [] })),
    } })
    const { result } = renderHook(() => useHistoryActions(setRuntimes, refs, updateRuntime, ipcSessionFeed))
    await act(async () => { await result.current.loadOlderHistory('session') })

    expect(runtimes.session?.entries).toHaveLength(1)
    expect(runtimes.session?.lastJsonlEntryAt).toBeNull()
    expect(sessionActivity(runtimes.session)).toMatchObject({
      timestamp: Date.parse('2026-09-20T09:05:00.000Z'),
      source: 'transcript',
    })
  })
})
