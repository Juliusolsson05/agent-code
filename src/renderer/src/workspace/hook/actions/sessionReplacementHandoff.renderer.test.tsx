import { act, renderHook } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UndoCloseStack } from '@renderer/lib/undoClose'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

import { useSessionActions } from './session'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

vi.mock('@renderer/workspace/hook/actions/initialHistory', () => ({
  loadInitialHistoryForSession: vi.fn(async () => undefined),
}))

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  vi.useRealTimers()
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

describe('renderer session replacement handoff', () => {
  it.each(['claude', 'codex', 'terminal'] as const)('preserves current text and destination-supported images when replacing with %s', async (destination) => {
    vi.useFakeTimers()
    const image = { id: 'draft-image', mediaType: 'image/png', base64Data: 'eA==', previewUrl: 'blob:draft', filename: 'draft.png' }
    const predecessorId = 'local-predecessor'
    let state = {
      tabs: [{
        id: 'tab-a',
        title: 'recorded',
      }],
      activeTabId: 'tab-a',
      sessions: {
        [predecessorId]: {
          cwd: '/recorded/worktree',
          kind: 'codex' as const,
          providerSessionId: 'recorded-provider-session',
          providerSessionIdSource: 'resume-request' as const,
          builtInMcpDomains: [],
          projectId: 'tab-a',
          joinedAt: 0,
        },
      },
      pinnedSessionIds: [],
      stage: oneLaneStage(predecessorId),
    } as WorkspaceState
    let runtimes: Record<SessionId, SessionRuntime> = {
      [predecessorId]: {
        ...emptyRuntime(),
        draftInput: 'keep this draft',
      },
    }
    const refs = {
      stateRef: ref(state),
      latestStateRef: ref(state),
      latestRuntimesRef: ref(runtimes),
      dangerousAgentsRef: ref(false),
      useProxyStreamingRef: ref(true),
      defaultBuiltInMcpDomainsRef: ref([]),
      seenUuidsRef: ref({}),
    historyWindowsRef: { current: {} } as never,
    historyAwaitingTurnStartRef: { current: new Set<string>() } as never,
      undoStackRef: ref(new UndoCloseStack()),
      bootstrapTimersRef: ref(new Map()),
      persistedFeedDebugIdRef: ref({}),
      inFlightFeedDebugIdRef: ref({}),
      paneToastTimers: ref({}),
      pendingAdoptionWindowIdsRef: ref<string[]>([]),
      saveTimerRef: ref(null),
      bootRef: ref(false),
    } as WorkspaceRefs
    const setState = (
      next: WorkspaceState | ((previous: WorkspaceState) => WorkspaceState),
    ): void => {
      state = typeof next === 'function' ? next(state) : next
      refs.stateRef.current = state
      refs.latestStateRef.current = state
    }
    const setRuntimes = (
      next: Record<SessionId, SessionRuntime> |
        ((previous: Record<SessionId, SessionRuntime>) => Record<SessionId, SessionRuntime>),
    ): void => {
      runtimes = typeof next === 'function' ? next(runtimes) : next
      refs.latestRuntimesRef.current = runtimes
    }
    const spawnSession = vi.fn()
      .mockImplementationOnce(async () => {
        setRuntimes(previous => ({ ...previous, [predecessorId]: { ...previous[predecessorId], draftInput: 'edited while spawning', draftImages: [image] } }))
        return { sessionId: 'local-successor', replacementTransactionId: 'replacement-transaction' }
      })
      .mockResolvedValueOnce({ sessionId: 'fresh-local-session' })
    const killOwnedSession = vi.fn(async () => false)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        spawnSession,
        killOwnedSession,
        ghostRead: vi.fn(async () => []),
      },
    })

    const { result } = renderHook(() => useSessionActions(
      {
        activeTabId: state.activeTabId,
        sessions: state.sessions,
        tabs: state.tabs,
      },
      setState,
      setRuntimes,
      refs,
    ))

    await act(async () => {
      await result.current.replaceSession('/recorded/worktree', {
        kind: destination,
        resumeSessionId: 'recorded-provider-session',
        builtInMcpOverrides: { workflows: true },
      })
      await vi.runAllTimersAsync()
    })

    expect(spawnSession).toHaveBeenCalledWith({
      kind: destination,
      cwd: '/recorded/worktree',
      resumeSessionId: 'recorded-provider-session',
      predecessorSessionId: predecessorId,
      // Main journals its handoff kill of the predecessor with this tag, so a
      // Codex reload reads as the user's swap, not as recovery (#1135).
      predecessorKillCaller: 'replace.predecessor',
      dangerousMode: destination === 'terminal' ? undefined : false,
      useProxy: destination === 'terminal' ? undefined : true,
      recoverTmuxName: undefined,
      builtInMcpDomains: destination === 'terminal' ? undefined : destination === 'codex' ? ['workflows'] : [],
      // Agents carry the pane's user MCP choices to main (#1143); terminals never do.
      ...(destination === 'terminal' ? {} : { userMcpOverrides: {} }),
    })
    // A transaction-bearing result means main already retired the predecessor
    // and is holding the successor pending durable workspace ownership. Sending
    // the legacy cleanup here is indistinguishable from an explicit close and
    // would correctly cancel the hidden successor before the remap can persist.
    expect(killOwnedSession).not.toHaveBeenCalled()
    // The successor stands exactly where the predecessor stood: same project,
    // same position in its index (`joinedAt` is INHERITED, not re-stamped — a
    // provider switch must not send the agent to the bottom of the list), and
    // the lane that showed the predecessor now shows it. Until #992 this was
    // one fact, "the tile leaf was swapped in place"; membership and the lane
    // are separate writes now, so each is asserted.
    expect(state.sessions[predecessorId]).toBeUndefined()
    expect(state.sessions['local-successor']).toMatchObject({ projectId: 'tab-a', joinedAt: 0 })
    expect(state.stage.lanes).toEqual([{ selectedSessionId: 'local-successor' }])
    expect(runtimes['local-successor']?.draftInput).toBe('edited while spawning')
    expect(runtimes['local-successor']?.draftImages).toEqual(destination === 'claude' ? [image] : [])

    await act(async () => {
      await result.current.spawn('/recorded/worktree', { kind: 'codex' })
      await vi.runAllTimersAsync()
    })
    expect(spawnSession).toHaveBeenNthCalledWith(2, {
      kind: 'codex',
      cwd: '/recorded/worktree',
      resumeSessionId: undefined,
      dangerousMode: false,
      useProxy: true,
      recoverTmuxName: undefined,
      builtInMcpDomains: [],
      userMcpOverrides: {},
    })
  })
})
