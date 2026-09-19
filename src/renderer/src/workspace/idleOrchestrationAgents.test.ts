import { describe, expect, it } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { CloseTargetSnapshot } from '@renderer/workspace/closeConfirmation'
import {
  currentIdleOrchestrationCloseTarget,
  idleOrchestrationCloseTargets,
} from '@renderer/workspace/idleOrchestrationAgents'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'
import type { Entry } from '@shared/types/transcript'

// Which orchestration workers Close Idle Orchestration Agents may close (#960).
//
// This is the filter in front of a destructive batch, so the exclusions are the
// contract: each case below is a session a regression would kill while the user
// approves a list they believe contains only finished workers. The close flow
// through the real executor is pinned in idleOrchestrationAgents.renderer.test.tsx.

const LEAD = 'lead'

/** A worker that has answered at least once and is quiet now: the one state
 *  the command is allowed to close. Entry payloads are irrelevant to the rule,
 *  which only asks whether assistant output exists. */
function answered(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    ...emptyRuntime(),
    processStatus: 'started',
    inputReady: true,
    entries: [{ type: 'user' } as Entry, { type: 'assistant' } as Entry],
    ...overrides,
  }
}

type WorkerSpec = {
  id: string
  /** Orchestration parent; defaults to the lead agent. `null` = not an
   *  orchestration child at all (an agent the user opened by hand). */
  parent?: string | null
  kind?: SessionMeta['kind']
  /** `null` = no runtime observed yet. */
  runtime?: SessionRuntime | null
  /** Not placed in any project (buried sessions have no tab placement). */
  buried?: boolean
}

/** One project tab: the user's lead agent is the grid root and every worker is
 *  a Dispatch row, filed in list order. */
function workspace(workers: WorkerSpec[]): { state: WorkspaceState; runtimes: Record<string, SessionRuntime> } {
  const sessions: WorkspaceState['sessions'] = { [LEAD]: { cwd: '/repo', kind: 'claude', title: 'Lead' } }
  const detachedSessions: WorkspaceState['detachedSessions'] = {}
  const runtimes: Record<string, SessionRuntime> = { [LEAD]: answered() }
  workers.forEach((worker, index) => {
    sessions[worker.id] = {
      cwd: `/repo/.worktrees/${worker.id}`,
      kind: worker.kind ?? 'codex',
      title: worker.id,
      ...(worker.parent === null
        ? {}
        : { orchestrationParentId: worker.parent ?? LEAD, orchestrationRootId: LEAD }),
    }
    if (!worker.buried) {
      detachedSessions[worker.id] = {
        sessionId: worker.id,
        surface: 'dispatch',
        projectTabId: 'tab',
        projectTabTitle: 'repo',
        projectTabIndex: 0,
        detachedAt: index + 1,
      }
    }
    if (worker.runtime !== null) runtimes[worker.id] = worker.runtime ?? answered()
  })
  const state: WorkspaceState = {
    tabs: [{ id: 'tab', title: 'repo', root: { type: 'leaf', sessionId: LEAD }, focusedSessionId: LEAD }],
    activeTabId: 'tab',
    dispatchMode: null,
    sessions,
    detachedSessions,
    gridRelatedSelections: {},
    buried: [],
    pinnedSessionIds: [],
  }
  return { state, runtimes }
}

const ids = (targets: readonly CloseTargetSnapshot[]): string[] => targets.map(target => target.sessionId)

describe('which orchestration workers count as idle', () => {
  it('lists a finished worker and never the lead agent, an agent the user opened, or a terminal', () => {
    const { state, runtimes } = workspace([
      { id: 'done' },
      { id: 'manual', parent: null },
      { id: 'shell', kind: 'terminal' },
    ])
    expect(ids(idleOrchestrationCloseTargets(state, runtimes))).toEqual(['done'])
  })

  it.each<[string, Partial<SessionRuntime>]>([
    ['running', { sessionStatus: 'running' }],
    ['streaming a response', { streamPhase: 'responding' }],
    ['a live process', { processActive: true }],
    ['a submitted prompt still awaiting its answer', { awaitingAssistant: true }],
  ])('leaves a worker with %s open', (_label, overrides) => {
    const { state, runtimes } = workspace([{ id: 'worker', runtime: answered(overrides) }])
    expect(idleOrchestrationCloseTargets(state, runtimes)).toEqual([])
  })

  it.each<[string, SessionRuntime | null]>([
    // The create_agent gap: spawned, provider ready, prompt not delivered or
    // not answered yet. Every activity signal reads quiet here, which is why
    // "idle" requires output rather than only the absence of work.
    ['has not answered anything yet', answered({ entries: [] })],
    ['has no observed runtime', null],
    // Dispatch paints these as exited or errored, not idle, and a failure is
    // something the user may still want to read.
    ['exited', answered({ exited: 0, processStatus: 'exited' })],
    ['failed', answered({ processStatus: 'failed', processError: 'spawn failed' })],
    // Unsettled evidence: replayed history can show old answers for a worker
    // whose process has not come back.
    ['is still spawning', answered({ processStatus: 'spawning' })],
    ['is replaying its history', answered({ bootstrapping: true })],
    ['is still loading its transcript', answered({ transcriptStatus: 'loading' })],
  ])('leaves a worker that %s open', (_label, runtime) => {
    const { state, runtimes } = workspace([{ id: 'worker', runtime }])
    expect(idleOrchestrationCloseTargets(state, runtimes)).toEqual([])
  })

  it('ignores a finished worker that is not placed in any project', () => {
    // closeSession never ends buried sessions; listing one would promise a
    // close that cannot happen.
    const { state, runtimes } = workspace([{ id: 'worker', buried: true }])
    expect(idleOrchestrationCloseTargets(state, runtimes)).toEqual([])
  })
})

describe('coordinators', () => {
  it('keeps a whole chain open while the worker at the bottom is still working', () => {
    // Closing `coord` or `sub` would leave `leaf` working for a parent that can
    // no longer wait on it or close it. The exclusion has to climb every level.
    const { state, runtimes } = workspace([
      { id: 'coord' },
      { id: 'sub', parent: 'coord' },
      { id: 'leaf', parent: 'sub', runtime: answered({ streamPhase: 'tool-use' }) },
      { id: 'other' },
    ])
    expect(ids(idleOrchestrationCloseTargets(state, runtimes))).toEqual(['other'])
  })

  it('includes a coordinator once every worker below it is being closed too', () => {
    const { state, runtimes } = workspace([
      { id: 'coord' },
      { id: 'sub', parent: 'coord' },
      { id: 'leaf', parent: 'sub' },
      { id: 'other' },
    ])
    expect(ids(idleOrchestrationCloseTargets(state, runtimes))).toEqual(['coord', 'sub', 'leaf', 'other'])
  })

  it('refuses a coordinator at its kill boundary while any worker is still open, even an idle one', () => {
    // The bulk loop closes workers first, so a worker still present at the
    // coordinator's turn survived that pass (changed, failed, or spawned after
    // the dialog). The enumeration rule "all children are targets" would wave
    // this through; the kill-boundary rule must not.
    const { state, runtimes } = workspace([{ id: 'coord' }, { id: 'worker', parent: 'coord' }])
    expect(currentIdleOrchestrationCloseTarget(state, runtimes, 'coord')).toBeNull()
    expect(currentIdleOrchestrationCloseTarget(state, runtimes, 'worker')).toMatchObject({
      sessionId: 'worker',
      live: false,
    })
  })
})
