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

// #1250 row 12: a failed page used to clear the spinner and nothing else, and
// returned nothing, so no caller could tell the user. The hook now answers
// what happened, and a failure leaves `hasOlderHistory` set so the next
// scroll to the top retries.
describe('what an older-history request reports', () => {
  function harness(runtime: Partial<SessionRuntime>) {
    let runtimes: Record<string, SessionRuntime> = { session: { ...emptyRuntime(), ...runtime } }
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
    const { result } = renderHook(() => useHistoryActions(setRuntimes, refs, updateRuntime, ipcSessionFeed))
    return { load: () => result.current.loadOlderHistory('session'), runtime: () => runtimes.session!, refs }
  }

  it('answers failed when the page cannot be read, and leaves a retry possible', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    Object.defineProperty(window, 'api', { configurable: true, value: {
      loadOlderHistory: vi.fn(async () => { throw new Error("ENOENT: no such file or directory, open '/Users/someone/.claude/projects/x.jsonl'") }),
      gitWorktrees: vi.fn(async () => ({ ok: true, worktrees: [] })),
    } })
    const { load, runtime } = harness({ hasOlderHistory: true, historyOldestMarker: 'anchor' })
    let answer: unknown
    await act(async () => { answer = await load() })
    expect(answer).toBe('failed')
    expect(runtime()).toMatchObject({ hasOlderHistory: true, loadingOlderHistory: false })
    vi.restoreAllMocks()
  })

  // #1413 review c: every early return is `skipped`, never `failed`. A
  // `failed` here would toast "Couldn't load older messages" on every scroll
  // tick of a feed that simply has nothing older.
  it.each([
    ['no older history', { hasOlderHistory: false, historyOldestMarker: 'anchor' }],
    ['a load already running', { hasOlderHistory: true, loadingOlderHistory: true, historyOldestMarker: 'anchor' }],
  ] as const)('answers skipped for %s', async (_name, runtime) => {
    const loadOlderHistory = vi.fn()
    Object.defineProperty(window, 'api', { configurable: true, value: { loadOlderHistory, gitWorktrees: vi.fn() } })
    const { load } = harness(runtime)
    let answer: unknown
    await act(async () => { answer = await load() })
    expect(answer).toBe('skipped')
    expect(loadOlderHistory).not.toHaveBeenCalled()
  })

  it('answers skipped for a session it cannot page (no meta, no provider session)', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: { loadOlderHistory: vi.fn(), gitWorktrees: vi.fn() } })
    const { load, refs } = harness({ hasOlderHistory: true, historyOldestMarker: 'anchor' })
    let answer: unknown
    ;(refs.stateRef.current as { sessions: Record<string, unknown> }).sessions = { session: { kind: 'claude', cwd: '/tmp/project' } }
    await act(async () => { answer = await load() })
    expect(answer).toBe('skipped')
    ;(refs.stateRef.current as { sessions: Record<string, unknown> }).sessions = {}
    await act(async () => { answer = await load() })
    expect(answer).toBe('skipped')
  })

  it('answers loaded for a page, and skipped when nothing was asked', async () => {
    Object.defineProperty(window, 'api', { configurable: true, value: {
      loadOlderHistory: vi.fn(async () => ({ entries: [], hasMore: false })),
      gitWorktrees: vi.fn(async () => ({ ok: true, worktrees: [] })),
    } })
    const loaded = harness({ hasOlderHistory: true, historyOldestMarker: 'anchor' })
    let answer: unknown
    await act(async () => { answer = await loaded.load() })
    expect(answer).toBe('loaded')
    const noMarker = harness({ hasOlderHistory: true, historyOldestMarker: null })
    await act(async () => { answer = await noMarker.load() })
    expect(answer).toBe('skipped')
  })
})

// #1430 review c: the older-history loader's half of the round-1 fix was
// untested. A page read while `git worktree list` timed out must reach the live
// reconciler (so a recovered catalog replays it), and must NOT be attributed
// against a null family (ingestWorktreeRawEvent would throw on it).
describe('an older page read while git timed out (#1430)', () => {
  it('hands the page to the reconciler, asks it to refresh, and attributes nothing', async () => {
    let runtimes: Record<string, SessionRuntime> = {
      session: { ...emptyRuntime(), hasOlderHistory: true, historyOldestMarker: 'anchor' },
    }
    const observed: unknown[][] = []
    const refresh = vi.fn(async () => 'failed' as const)
    const refs = {
      stateRef: ref({ sessions: { session: { kind: 'claude', cwd: '/tmp/project', providerSessionId: 'provider-session' } } }),
      latestRuntimesRef: ref(runtimes),
      seenUuidsRef: ref({}),
      worktreeReconcilerRef: ref({
        observe: (_s: string, _c: string, entries: Array<{ entry: unknown }>, projection: unknown) => { observed.push(entries.map(e => e.entry)); return projection },
        refresh,
      }),
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
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/tmp/project/.worktrees/x/a.ts' } }] },
    }
    Object.defineProperty(window, 'api', { configurable: true, value: {
      loadOlderHistory: vi.fn().mockResolvedValue({ entries: [{ entries: [older], historyMarker: 'older-1' }], hasMore: false }),
      gitWorktrees: vi.fn(async () => ({ ok: false, gitMissing: false, timedOut: true })),
    } })
    const { result } = renderHook(() => useHistoryActions(setRuntimes, refs, updateRuntime, ipcSessionFeed))
    let outcome: unknown
    await act(async () => { outcome = await result.current.loadOlderHistory('session') })

    expect(outcome).not.toBe('failed')
    expect(observed).toEqual([[{ entries: [older], historyMarker: 'older-1' }]])
    expect(refresh).toHaveBeenCalledWith('/tmp/project')
    // Nothing was attributed against the unknown family: no activity folded
    // from the page, no work context derived from it.
    expect(runtimes.session?.workActivity).toBeNull()
    expect(runtimes.session?.workContext).toBeNull()
  })
})
