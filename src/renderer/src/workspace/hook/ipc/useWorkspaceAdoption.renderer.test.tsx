import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkspaceAdoption } from '@renderer/workspace/hook/ipc/useWorkspaceAdoption'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

// The renderer half of the workspace handoff.
//
// This is the half that decides when it is safe for main to DESTROY the only
// surviving copy of a closed window's workspace, so the properties asserted
// here are the ones that authorize data deletion:
//
//   - a merge that could not be applied must never confirm;
//   - a confirmation must be queued for the autosave that proves durability,
//     never sent because the merge landed in memory;
//   - an adoption that arrives before this window has restored itself must not
//     be applied, because rehydrate's first publish replaces state wholesale
//     and would erase it — after main had already deleted the original.

type AdoptHandler = (request: { windowId: string; workspace: string }) => void

const { onWorkspaceAdopt, confirmWorkspaceAdoption, refuseWorkspaceAdoption, getBackendSnapshot } =
  vi.hoisted(() => ({
    onWorkspaceAdopt: vi.fn(),
    confirmWorkspaceAdoption: vi.fn(async () => undefined),
    refuseWorkspaceAdoption: vi.fn(async () => undefined),
    getBackendSnapshot: vi.fn(async (_sessionId: string): Promise<unknown> => null),
  }))

const loadInitialHistoryForSession = vi.hoisted(
  () => vi.fn(async (_options: { sessionId: string }): Promise<void> => undefined),
)
vi.mock('@renderer/workspace/hook/actions/initialHistory', () => ({
  loadInitialHistoryForSession,
}))

function meta(cwd: string): SessionMeta {
  return { cwd, kind: 'claude' }
}

function survivorState(): WorkspaceState {
  return {
    tabs: [{
      id: 'tab-own',
      title: 'own',
      root: { type: 'leaf', sessionId: 'own-agent' },
      focusedSessionId: 'own-agent',
    }],
    activeTabId: 'tab-own',
    dispatchMode: null,
    sessions: { 'own-agent': meta('/own') },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
  }
}

function closedWindowPayload(): string {
  return JSON.stringify({
    workspace: {
      tabs: [{
        id: 'tab-closed',
        title: 'closed',
        root: { type: 'leaf', sessionId: 'grid-a' },
        focusedSessionId: 'grid-a',
      }],
      activeTabId: 'tab-closed',
      dispatchMode: null,
      sessions: { 'grid-a': meta('/closed'), parked: meta('/closed') },
      detachedSessions: {
        parked: {
          sessionId: 'parked',
          surface: 'dispatch',
          projectTabId: 'tab-closed',
          projectTabTitle: 'closed',
          projectTabIndex: 0,
          detachedAt: 1,
        },
      },
      buried: [],
      tileTabs: null,
    },
  })
}

type Harness = {
  refs: WorkspaceRefs
  state: WorkspaceState
  runtimes: Record<SessionId, SessionRuntime>
  fire: AdoptHandler
}

function harness(bootstrapComplete: boolean): Harness {
  const state = survivorState()
  const runtimes: Record<SessionId, SessionRuntime> = { 'own-agent': emptyRuntime() }
  const refs = {
    latestStateRef: { current: state },
    stateRef: { current: state },
    latestRuntimesRef: { current: runtimes },
    pendingAdoptionWindowIdsRef: { current: [] as string[] },
  } as unknown as WorkspaceRefs

  const captured: { handler?: AdoptHandler } = {}
  onWorkspaceAdopt.mockImplementation((cb: AdoptHandler) => {
    captured.handler = cb
    return () => undefined
  })

  const result: Harness = {
    refs,
    state,
    runtimes,
    fire: request => captured.handler?.(request),
  }

  renderHook(({ ready }: { ready: boolean }) => useWorkspaceAdoption(
    refs,
    updater => {
      const next = typeof updater === 'function'
        ? (updater as (prev: WorkspaceState) => WorkspaceState)(refs.latestStateRef.current)
        : updater
      refs.latestStateRef.current = next
      Object.assign(result, { state: next })
    },
    updater => {
      const next = typeof updater === 'function'
        ? (updater as (
            prev: Record<SessionId, SessionRuntime>,
          ) => Record<SessionId, SessionRuntime>)(refs.latestRuntimesRef.current)
        : updater
      refs.latestRuntimesRef.current = next
      Object.assign(result, { runtimes: next })
    },
    ready,
  ), { initialProps: { ready: bootstrapComplete } })

  return result
}

beforeEach(() => {
  onWorkspaceAdopt.mockReset()
  confirmWorkspaceAdoption.mockReset().mockResolvedValue(undefined)
  refuseWorkspaceAdoption.mockReset().mockResolvedValue(undefined)
  getBackendSnapshot.mockReset().mockResolvedValue(null)
  loadInitialHistoryForSession.mockReset().mockResolvedValue(undefined)
  ;(window as unknown as { api: unknown }).api = {
    onWorkspaceAdopt,
    confirmWorkspaceAdoption,
    refuseWorkspaceAdoption,
    getBackendSnapshot,
  }
})

describe('adopting a closed window', () => {
  it('queues the confirmation for autosave instead of sending it on merge', async () => {
    const h = harness(true)
    h.fire({ windowId: 'closed-window', workspace: closedWindowPayload() })

    await waitFor(() => {
      expect(h.refs.latestStateRef.current.tabs.map(t => t.id))
        .toEqual(['tab-own', 'tab-closed'])
    })
    // Main DELETES the closed window's slice on confirmation. Sending it here
    // would make any crash in the next 400ms permanent data loss, because the
    // merge is not durable until this window's autosave commits.
    expect(confirmWorkspaceAdoption).not.toHaveBeenCalled()
    expect(h.refs.pendingAdoptionWindowIdsRef.current).toEqual(['closed-window'])
  })

  it('seeds a runtime for parked sessions, not just the painted ones', async () => {
    const h = harness(true)
    h.fire({ windowId: 'closed-window', workspace: closedWindowPayload() })

    await waitFor(() => {
      expect(h.refs.latestRuntimesRef.current.parked).toBeDefined()
    })
    // `ensureSessionLive` — the wake path behind Attach to Grid and revive —
    // no-ops every runtime write when the entry is missing, so a parked agent
    // adopted without one wakes into an empty feed with no transcript and no
    // way to report failure.
    expect(h.refs.latestRuntimesRef.current['grid-a']).toBeDefined()
    // A parked agent has no backend; claiming `started` would make the row lie
    // about running.
    expect(h.refs.latestRuntimesRef.current.parked?.processStatus).toBe('idle')
  })

  it('seeds readiness from the backend snapshot so a live pane is not stuck "starting"', async () => {
    getBackendSnapshot.mockImplementation(async (sessionId: string) => (
      sessionId === 'grid-a'
        ? {
            sessionId,
            kind: 'claude',
            cwd: '/closed',
            lifecycle: 'live',
            input: { ready: true, reason: null, revision: 7 },
          }
        : null
    ))

    const h = harness(true)
    h.fire({ windowId: 'closed-window', workspace: closedWindowPayload() })

    await waitFor(() => {
      expect(h.refs.latestRuntimesRef.current['grid-a']?.inputReady).toBe(true)
    })
    // Main's setInputReadiness dedupes on (ready, reason), so a healthy agent
    // already sitting at ready:true emits nothing to a renderer that just
    // started watching it. Without the snapshot the pane reads "starting agent"
    // forever and its first send detours through a full recovery round trip.
    expect(h.refs.latestRuntimesRef.current['grid-a']?.processStatus).toBe('started')
    expect(h.refs.latestRuntimesRef.current['grid-a']?.inputReadinessRevision).toBe(7)
  })

  it('loads history for adopted leaves only', async () => {
    const h = harness(true)
    h.fire({ windowId: 'closed-window', workspace: closedWindowPayload() })

    await waitFor(() => expect(loadInitialHistoryForSession).toHaveBeenCalled())
    // A parked agent's transcript is fetched when it is actually woken; paging
    // durable history for every adopted row would be a burst with no consumer.
    expect(loadInitialHistoryForSession.mock.calls.map(call => call[0].sessionId))
      .toEqual(['grid-a'])
  })

  it('refuses an unreadable payload without confirming', async () => {
    const h = harness(true)
    h.fire({ windowId: 'closed-window', workspace: 'not json' })

    await waitFor(() => expect(refuseWorkspaceAdoption).toHaveBeenCalledWith('closed-window'))
    expect(confirmWorkspaceAdoption).not.toHaveBeenCalled()
    // Nothing merged: the closed workspace comes back as its own window.
    expect(h.refs.latestStateRef.current.tabs).toHaveLength(1)
  })

  it('refuses an id collision without confirming', async () => {
    const h = harness(true)
    const colliding = JSON.parse(closedWindowPayload()) as {
      workspace: { sessions: Record<string, SessionMeta> }
    }
    colliding.workspace.sessions['own-agent'] = meta('/collision')
    h.fire({ windowId: 'closed-window', workspace: JSON.stringify(colliding) })

    await waitFor(() => expect(refuseWorkspaceAdoption).toHaveBeenCalledWith('closed-window'))
    expect(confirmWorkspaceAdoption).not.toHaveBeenCalled()
  })

  it('does not apply an adoption that arrives before this window has restored', async () => {
    const h = harness(false)
    h.fire({ windowId: 'closed-window', workspace: closedWindowPayload() })

    // Give the async applier every chance to run if the gate were missing.
    await new Promise(resolve => setTimeout(resolve, 10))

    // rehydrate publishes its result as a WHOLESALE replacement of tabs,
    // sessions, detached records, buried panes and pins. Anything merged before
    // that publish is erased — and main would already have deleted the
    // original, so it would be gone from disk too.
    expect(h.refs.latestStateRef.current.tabs).toHaveLength(1)
    expect(h.refs.pendingAdoptionWindowIdsRef.current).toEqual([])
    expect(confirmWorkspaceAdoption).not.toHaveBeenCalled()
    expect(refuseWorkspaceAdoption).not.toHaveBeenCalled()
  })
})
