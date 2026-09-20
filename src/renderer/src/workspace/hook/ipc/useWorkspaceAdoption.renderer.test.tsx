import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useWorkspaceAdoption } from '@renderer/workspace/hook/ipc/useWorkspaceAdoption'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import type { SessionId, SessionMeta, WorkspaceState } from '@renderer/workspace/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

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
    }],
    activeTabId: 'tab-own',
    stage: oneLaneStage('own-agent'),
    sessions: { 'own-agent': { ...meta('/own'), projectId: 'tab-own', joinedAt: 0 }},
    pinnedSessionIds: [],
  }
}

/**
 * What a closed window's autosave actually wrote: the v3 shape, and only it
 * (useAutoSave.ts). `grid-a` is the agent its one lane showed; `parked` is a
 * pool row no lane showed. The names are from when those were a tile leaf and
 * a detached record — two owner structures that are one thing now.
 *
 * The payload was briefly a hybrid (v2 `tabs` with no tile `root`, v3 rows).
 * No build ever wrote that, and adoption's input is a FILE, so it is exactly
 * the place a fixture must not invent a shape.
 */
function closedWindowPayload(): string {
  return JSON.stringify({
    workspace: {
      projects: [{ id: 'tab-closed', title: 'closed' }],
      activeProjectId: 'tab-closed',
      stage: oneLaneStage('grid-a'),
      sessions: { 'grid-a': { ...meta('/closed'), projectId: 'tab-closed', joinedAt: 0 }, parked: { ...meta('/closed'), projectId: 'tab-closed', joinedAt: 1 }},
      pinnedSessionIds: [],
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

  // #895. A permission or question pending when a window closes vanished from
  // the adopting window: the adopted runtime is seeded from `emptyRuntime()`,
  // whose `conditions` is null, and providers publish conditions only when
  // they CHANGE — the OpenCode Terminal package and claude-code-headless both
  // deduplicate — so nothing ever re-sent them. Dispatch lost ACTION/QUESTION
  // and orchestration summaries stopped naming the blocker, while the raw TUI
  // still showed the prompt. Found by review R4 of #882; generic, not
  // OpenCode-specific.
  //
  // The fix does NOT carry the snapshot on this window's `getBackendSnapshot`
  // reply. Conditions have no revision, so a reply raced against live events
  // cannot be ordered against them — the first attempt compared `ts`, and 1 ms
  // ties are genuinely unordered, so a prompt answered in the same millisecond
  // it appeared could be restored onto the user's screen. Main re-emits on the
  // ordinary event channel instead, which is ordered by construction.
  it('asks main to re-emit blockers AFTER its runtimes exist, never before', async () => {
    getBackendSnapshot.mockImplementation(async (sessionId: string) => (
      sessionId === 'grid-a'
        ? { sessionId, kind: 'claude', cwd: '/closed', lifecycle: 'live', input: { ready: true, reason: null, revision: 7 } }
        : null
    ))
    // The ONE thing that makes this correct is the ORDER: a re-emit that
    // landed before the seed would be overwritten by `emptyRuntime()`, which
    // is the bug it exists to fix. So the assertion is what the runtime map
    // looked like AT THE MOMENT the request went out, not afterwards.
    let seededWhenAsked: string[] = []
    let askedFor: string[] = []
    const reseedSessionConditions = vi.fn(async (ids: string[]) => {
      askedFor = ids
      seededWhenAsked = Object.keys(h.refs.latestRuntimesRef.current)
      return ids.length
    })
    ;(window as unknown as { api: Record<string, unknown> }).api.reseedSessionConditions = reseedSessionConditions

    const h = harness(true)
    h.fire({ windowId: 'closed-window', workspace: closedWindowPayload() })

    await waitFor(() => expect(reseedSessionConditions).toHaveBeenCalled())
    // Every adopted session is asked for, parked ones included: main answers
    // only for the ones it actually holds a snapshot for.
    expect(askedFor).toEqual(expect.arrayContaining(['grid-a', 'parked']))
    expect(seededWhenAsked).toEqual(expect.arrayContaining(['grid-a', 'parked']))
  })

  it('adopts normally against a preload that has no re-emit at all', async () => {
    // The hint is not a step. An older shell, or a test double that does not
    // care, must still get its workspace back.
    delete (window as unknown as { api: Record<string, unknown> }).api.reseedSessionConditions
    const h = harness(true)
    h.fire({ windowId: 'closed-window', workspace: closedWindowPayload() })
    await waitFor(() => expect(h.refs.latestRuntimesRef.current.parked).toBeDefined())
    expect(h.refs.pendingAdoptionWindowIdsRef.current).toEqual(['closed-window'])
  })

  it('keeps an exit observed while the snapshot was in flight (#1083 review, finding 2)', async () => {
    // Routing moves to this window BEFORE the offer arrives, so the live
    // channel can write `exited` while `getBackendSnapshot` is still in
    // flight. The reply was computed while the backend was alive; applying it
    // blindly repaints a dead agent as `started` with an enabled composer.
    // Both sibling seed sites already guarded this; adoption did not.
    let resolveSnapshot: (value: unknown) => void = () => {}
    getBackendSnapshot.mockImplementation(async (sessionId: string) => {
      if (sessionId !== 'grid-a') return null
      return await new Promise(resolve => { resolveSnapshot = resolve })
    })

    const h = harness(true)
    h.fire({ windowId: 'closed-window', workspace: closedWindowPayload() })
    await waitFor(() => expect(getBackendSnapshot).toHaveBeenCalled())

    // The PTY dies mid-fetch, exactly as `onSessionExit` writes it.
    h.refs.latestRuntimesRef.current = {
      ...h.refs.latestRuntimesRef.current,
      'grid-a': { ...emptyRuntime(), processStatus: 'exited', exited: 0, recoveryFailureCode: null } as SessionRuntime,
    }
    resolveSnapshot({
      sessionId: 'grid-a', kind: 'claude', cwd: '/closed', lifecycle: 'live',
      input: { ready: true, reason: null, revision: 7 },
    })

    await waitFor(() => expect(h.refs.latestRuntimesRef.current.parked).toBeDefined())
    expect(h.refs.latestRuntimesRef.current['grid-a']).toMatchObject({ processStatus: 'exited', exited: 0 })
  })

  it('loads history only for adopted sessions that have a live backend', async () => {
    // Re-based with #992. The rule was "tile leaves load, detached rows do
    // not" — a structural stand-in for "has a backend", because the closed
    // window had spawned exactly its leaves. It asks main directly now: a
    // session main still holds a live backend for is one the user can read and
    // type into the moment it is adopted, so its transcript is loaded; every
    // other row is parked and loads when it is woken.
    getBackendSnapshot.mockImplementation(async (sessionId: string) => (
      sessionId === 'grid-a'
        ? { sessionId, kind: 'claude', cwd: '/closed', lifecycle: 'live', input: { ready: true, reason: null, revision: 1 } }
        : null
    ))
    const h = harness(true)
    h.fire({ windowId: 'closed-window', workspace: closedWindowPayload() })

    await waitFor(() => expect(loadInitialHistoryForSession).toHaveBeenCalled())
    // A parked agent's transcript is fetched when it is actually woken; paging
    // durable history for every adopted row would be a burst with no consumer.
    expect(loadInitialHistoryForSession.mock.calls.map(call => call[0].sessionId))
      .toEqual(['grid-a'])
  })

  it('loads no history when the closed window left no live backend behind', async () => {
    // The default mock: main knows none of these sessions. Everything adopted
    // is parked, so nothing is paged in — and the adoption still lands.
    const h = harness(true)
    h.fire({ windowId: 'closed-window', workspace: closedWindowPayload() })

    await waitFor(() => expect(h.refs.latestRuntimesRef.current.parked).toBeDefined())
    expect(loadInitialHistoryForSession).not.toHaveBeenCalled()
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
    // Filed under the closed window's project: an UNFILED row would be dropped
    // as unowned before the merge ever compared ids, and the adoption would
    // (correctly) succeed — testing the ownership prune, not the collision.
    colliding.workspace.sessions['own-agent'] = { ...meta('/collision'), projectId: 'tab-closed', joinedAt: 2 }
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
