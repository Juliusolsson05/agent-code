import { act, renderHook } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { WorkspaceState } from '@renderer/workspace/types'

import { SAVE_FAILURE_BANNER_AFTER, useAutoSave } from './useAutoSave'
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

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
      }],
      activeTabId: 'tab-a',
      stage: oneLaneStage('successor'),
      sessions: {
        successor: { cwd: '/recorded/worktree', kind: 'codex', projectId: 'tab-a', joinedAt: 0 },
      },
      pinnedSessionIds: [],
    }
    const refs = {
      latestStateRef: ref(state),
      latestRuntimesRef: ref({ successor: emptyRuntime() }),
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

  it('writes the live stage and the v3 project triple, and no v2 mode envelope (#992)', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const state: WorkspaceState = {
      tabs: [{
        id: 'tab-a',
        title: 'recorded',
      }],
      activeTabId: 'tab-a',
      // The user's actual shape: three lanes, the middle one empty by choice,
      // focus on the last. Autosave must write THIS, verbatim.
      //
      // Through stage 2 of #992 this case had no stored grid and asserted the
      // opposite kind of thing — that the v3 half was DERIVED at save time
      // (the seeded [2] default, focused session in lane 0). A derived stage
      // at the durability boundary would now overwrite the user's lanes with
      // a guess on every save, so the contract is inverted: what is in memory
      // is what is written.
      stage: {
        lanes: [{ selectedSessionId: 'successor' }, {}, { selectedSessionId: 'successor' }],
        rows: [{ length: 3 }],
        focusedLane: 2,
      },
      sessions: {
        successor: { cwd: '/recorded/worktree', kind: 'codex', projectId: 'tab-a', joinedAt: 0 },
      },
      pinnedSessionIds: [],
    }
    const refs = {
      latestStateRef: ref(state),
      latestRuntimesRef: ref({ successor: emptyRuntime() }),
      saveTimerRef: ref<ReturnType<typeof setTimeout> | null>(null),
    } as unknown as WorkspaceRefs
    const saveWorkspace = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { saveWorkspace },
    })

    const { unmount } = renderHook(() => useAutoSave(state, 0, refs, true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(saveWorkspace).toHaveBeenCalledTimes(1)

    const saved = JSON.parse(saveWorkspace.mock.calls[0][0]).workspace
    expect(saved.projects).toEqual([{ id: 'tab-a', title: 'recorded' }])
    expect(saved.activeProjectId).toBe('tab-a')
    expect(saved.stage).toEqual({
      lanes: [{ selectedSessionId: 'successor' }, {}, { selectedSessionId: 'successor' }],
      rows: [{ length: 3 }],
      focusedLane: 2,
    })
    // v3 ONLY. Not one v2 field is written: no mode envelope, and — since the
    // tile tree and the detached/buried buckets were deleted in 3b-ii — no
    // `tabs`, which was the last of them. Writing an empty or synthesized
    // `tabs` "for compatibility" would be worse than omitting it: an older
    // build would read it as a real, EMPTY workspace, boot a fresh tab over it
    // and autosave that, erasing the pool. With the key absent the older build
    // fails its shape check and lands in persisted-fallback with autosave
    // LOCKED, so a downgrade cannot destroy a file it does not understand.
    expect(saved).not.toHaveProperty('dispatchMode')
    expect(saved).not.toHaveProperty('tabs')
    expect(saved).not.toHaveProperty('activeTabId')
    expect(saved).not.toHaveProperty('detachedSessions')
    expect(saved).not.toHaveProperty('buried')
    // Ownership travels ON the row, which is why none of the above is needed.
    expect(saved.sessions.successor).toMatchObject({ projectId: 'tab-a', joinedAt: 0 })

    unmount()
  })

  it('retries a failed unload flush when another guard vetoes the unload', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const state: WorkspaceState = {
      tabs: [{
        id: 'tab-a',
        title: 'recorded',
      }],
      activeTabId: 'tab-a',
      stage: oneLaneStage('successor'),
      sessions: {
        successor: { cwd: '/recorded/worktree', kind: 'codex', projectId: 'tab-a', joinedAt: 0 },
      },
      pinnedSessionIds: [],
    }
    const refs = {
      latestStateRef: ref(state),
      latestRuntimesRef: ref({ successor: emptyRuntime() }),
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
      }],
      activeTabId: 'tab-a',
      stage: oneLaneStage('successor'),
      sessions: {
        successor: { cwd: '/recorded/worktree', kind: 'codex', projectId: 'tab-a', joinedAt: 0 },
      },
      pinnedSessionIds: [],
    }
    const refs = {
      latestStateRef: ref(state),
      latestRuntimesRef: ref({ successor: emptyRuntime() }),
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

  // #1244: persistent save failures used to reach only console.warn while the
  // backoff retried forever; the user kept working on changes lost at quit.
  it('reports a save error after repeated failures and clears it on the next success', async () => {
    // A genuine filesystem error, wrapped the way Electron IPC delivers it.
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-save-'))
    await chmod(directory, 0o555)
    const realError = await writeFile(join(directory, 'workspace.json'), '{}').then(() => null, (error: Error) => error)
    await chmod(directory, 0o755)
    await rm(directory, { recursive: true, force: true })
    expect(realError).not.toBeNull()
    const ipcError = new Error(`Error invoking remote method 'workspace:save': ${String(realError)}`)

    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const state: WorkspaceState = {
      tabs: [{ id: 'tab-a', title: 'recorded' }], activeTabId: 'tab-a', stage: oneLaneStage('s'),
      sessions: { s: { cwd: '/recorded', kind: 'claude', projectId: 'tab-a', joinedAt: 0 } }, pinnedSessionIds: [],
    }
    const refs = {
      latestStateRef: ref(state), latestRuntimesRef: ref({ s: emptyRuntime() }),
      saveTimerRef: ref<ReturnType<typeof setTimeout> | null>(null),
    } as unknown as WorkspaceRefs
    let failing = true
    const saveWorkspace = vi.fn(async () => { if (failing) throw ipcError })
    Object.defineProperty(window, 'api', { configurable: true, value: { saveWorkspace } })
    const health = vi.fn()
    const { unmount } = renderHook(() => useAutoSave(state, 0, refs, true, health))

    // Step by ATTEMPT, not by time: the backoff fits several into a second.
    const until = async (attempts: number) => {
      while (saveWorkspace.mock.calls.length < attempts) {
        await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      }
      await act(async () => { await Promise.resolve() })
    }
    await until(SAVE_FAILURE_BANNER_AFTER - 1)
    expect(health).not.toHaveBeenCalledWith(expect.any(String))
    await until(SAVE_FAILURE_BANNER_AFTER)
    // The storage error itself, without the IPC channel wrapper.
    expect(health).toHaveBeenLastCalledWith(String(realError!).replace(/^Error: /, ''))
    expect(String(health.mock.lastCall![0])).toMatch(/EACCES/)

    failing = false
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(health).toHaveBeenLastCalledWith(null)
    unmount()
  })
})
