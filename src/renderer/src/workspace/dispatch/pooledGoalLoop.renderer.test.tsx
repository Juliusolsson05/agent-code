import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DispatchAgentList } from './DispatchAgentList'
import type { DispatchAgentRow } from './dispatchSelectors'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import type { GoalLoopState } from '@shared/types/goalLoop'

// ---------------------------------------------------------------------------
// #1031 item 2. `GoalLoopPane` is mounted only by `TileTree`, i.e. only for a
// session occupying a lane, so a loop running on a POOLED agent had no surface
// at all — and `commandTargetSessionId` resolves the focused lane's occupant,
// so Stop Goal Loop could not reach it either. Orchestration children always
// land in the pool, so this is the common case.
//
// The list is rendered FOR REAL, with its own store selectors and its own IPC
// calls; only the two `window.api` methods are stubbed, at the process
// boundary.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  settings: { dispatchColorFlags: {} },
  workspaceRuntimes: {} as Record<string, SessionRuntime>,
}))
vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state),
}))

const row = (sessionId: string, index: number, depth = 0): DispatchAgentRow => ({
  key: `project:${sessionId}`, label: `A${index}`, globalIndex: index,
  tabId: 'project', tabTitle: 'Project', tabIndex: 0, sessionId,
  kind: 'claude', title: sessionId, depth,
})
const rows = [row('placed', 1), row('pooled', 2)]
/** A parent with 5 orchestration children: the child cap hides all but three. */
const familyRows = [row('parent', 1), ...[1, 2, 3, 4, 5].map(n => row(`worker-${n}`, n + 1, 1))]

function loop(overrides: Partial<GoalLoopState> = {}): GoalLoopState {
  return {
    sessionId: 'pooled',
    phase: 'active',
    goal: 'Finish the migration',
    continuationsDelivered: 8,
    maxContinuations: 25,
    ...overrides,
  } as GoalLoopState
}

/** The two IPC methods the index uses, and a way to fire the payload-free ping. */
function installGoalLoopBridge(loops: Record<string, GoalLoopState>) {
  const listeners = new Set<() => void>()
  const readGoalLoops = vi.fn(async (ids: string[]) => {
    const out: Record<string, GoalLoopState> = {}
    for (const id of ids) if (loops[id]) out[id] = loops[id]!
    return out
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      readGoalLoops,
      onGoalLoopChanged: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
  })
  return { readGoalLoops, ping: () => { for (const listener of listeners) listener() } }
}

const renderList = (listRows: DispatchAgentRow[] = rows) => render(<DispatchAgentList
  groups={[{ tab: { id: 'project', title: 'Project' }, tabIndex: 0, rows: listRows }]}
  pinnedRows={[]}
  activeSessionId="placed"
  focusSessionInTab={vi.fn()}
  showWorktreeBadges={false}
/>)

const chipOf = (sessionId: string): Element | null =>
  screen.getByText(sessionId).closest('button')!.querySelector('[data-dispatch-goal-loop]')

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
beforeEach(() => {
  for (const id of ['placed', 'pooled']) state.workspaceRuntimes[id] = emptyRuntime()
})
afterEach(() => {
  cleanup()
  state.workspaceRuntimes = {}
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
})

describe('a goal loop on a pooled agent (#1031 item 2)', () => {
  it('shows its iteration on the index row', async () => {
    installGoalLoopBridge({ pooled: loop() })
    renderList()

    await waitFor(() => { expect(chipOf('pooled')).not.toBeNull() })
    expect(chipOf('pooled')!.textContent).toContain('8/25')
    // The row explains what to do about it — the controls live behind
    // selecting the agent, because that is what makes it the command target.
    expect(chipOf('pooled')!.getAttribute('title')).toContain('stop it')
    // An agent with no loop gets no chip.
    expect(chipOf('placed')).toBeNull()
  })

  it('says so when the loop is paused, rather than showing a stale iteration', async () => {
    installGoalLoopBridge({ pooled: loop({ phase: 'paused', pauseReason: 'cap' } as Partial<GoalLoopState>) })
    renderList()
    await waitFor(() => { expect(chipOf('pooled')).not.toBeNull() })
    expect(chipOf('pooled')!.textContent).toContain('paused')
  })

  it('shows nothing once the loop has ended', async () => {
    // The pane strip keeps an ended loop so the user can read why it stopped.
    // In a list of twenty agents that would be noise that never clears, and
    // the index's job is to answer "what is happening now".
    installGoalLoopBridge({ pooled: loop({ phase: 'ended', endReason: 'done' } as Partial<GoalLoopState>) })
    renderList()
    await waitFor(() => { expect(screen.getByText('pooled')).toBeInTheDocument() })
    expect(chipOf('pooled')).toBeNull()
  })

  it('reads ONCE for the whole index, not once per agent', async () => {
    // `goal-loop:changed` is a payload-free ping, so every reader re-reads on
    // every ping. A per-row subscription would mean one IPC round trip per
    // listed agent per loop event — dozens, for a chip.
    const bridge = installGoalLoopBridge({ pooled: loop() })
    renderList()
    await waitFor(() => { expect(bridge.readGoalLoops).toHaveBeenCalled() })
    expect(bridge.readGoalLoops).toHaveBeenCalledTimes(1)
    expect(bridge.readGoalLoops.mock.calls[0]![0]).toEqual(['placed', 'pooled'])
  })

  it('follows the loop as it advances', async () => {
    const loops: Record<string, GoalLoopState> = { pooled: loop() }
    const bridge = installGoalLoopBridge(loops)
    renderList()
    await waitFor(() => { expect(chipOf('pooled')!.textContent).toContain('8/25') })

    loops.pooled = loop({ continuationsDelivered: 9 })
    bridge.ping()
    await waitFor(() => { expect(chipOf('pooled')!.textContent).toContain('9/25') })
  })

  it('renders the index even when the goal-loop bridge is absent', async () => {
    // Tests stub window.api partially, and an index that crashes over a
    // missing IPC method is far worse than one that shows no chips.
    Object.defineProperty(window, 'api', { configurable: true, value: {} })
    renderList()
    await waitFor(() => { expect(screen.getByText('pooled')).toBeInTheDocument() })
    expect(chipOf('pooled')).toBeNull()
  })
})

describe('a goal loop on a COLLAPSED orchestration child (#1063 review)', () => {
  // The feature's own headline case: the child cap hides every child past the
  // third, and orchestration children are exactly the agents that land in the
  // pool running a loop. A 5-worker run showed chips for two workers and said
  // nothing at all about the other three.
  beforeEach(() => {
    for (const id of ['parent', 'worker-1', 'worker-2', 'worker-3', 'worker-4', 'worker-5']) {
      state.workspaceRuntimes[id] = emptyRuntime()
    }
  })

  const collapseRow = () => screen.getByText(/\+ \d+ more/).closest('button')!

  it('announces it on the "+N more" row', async () => {
    installGoalLoopBridge({ 'worker-5': loop({ sessionId: 'worker-5' }) })
    renderList(familyRows)
    await waitFor(() => {
      expect(collapseRow().querySelector('[data-dispatch-goal-loop]')).not.toBeNull()
    })
    expect(collapseRow().querySelector('[data-dispatch-goal-loop]')!.textContent).toContain('8/25')
  })

  it('counts them when several hidden children are looping', async () => {
    installGoalLoopBridge({
      'worker-4': loop({ sessionId: 'worker-4' }),
      'worker-5': loop({ sessionId: 'worker-5' }),
    })
    renderList(familyRows)
    await waitFor(() => {
      expect(collapseRow().querySelector('[data-dispatch-goal-loop]')?.textContent).toContain('2 loops')
    })
  })

  it('says nothing when only a VISIBLE child is looping — its own row carries that', async () => {
    installGoalLoopBridge({ 'worker-1': loop({ sessionId: 'worker-1' }) })
    renderList(familyRows)
    await waitFor(() => { expect(chipOf('worker-1')).not.toBeNull() })
    expect(collapseRow().querySelector('[data-dispatch-goal-loop]')).toBeNull()
  })
})

describe('goal loop chip states (#1063 review)', () => {
  it('shows a BLOCKED loop even though it has ended', async () => {
    // `goal_loop_complete` with outcome "blocked" means the agent stopped
    // because it needs the user. Hiding it made the index silent about the one
    // loop state that is a request for attention.
    installGoalLoopBridge({ pooled: loop({ phase: 'ended', endReason: 'blocked' }) })
    renderList()
    await waitFor(() => { expect(chipOf('pooled')).not.toBeNull() })
    expect(chipOf('pooled')!.textContent).toContain('blocked')
    expect(chipOf('pooled')!.getAttribute('title')).toContain('needs you')
  })

  it('still hides a loop that ended normally', async () => {
    installGoalLoopBridge({ pooled: loop({ phase: 'ended', endReason: 'done' }) })
    renderList()
    await waitFor(() => { expect(screen.getByText('pooled')).toBeInTheDocument() })
    expect(chipOf('pooled')).toBeNull()
  })

  it('names the pause reason, and offers raise-cap only when the cap is why', async () => {
    installGoalLoopBridge({ pooled: loop({ phase: 'paused', pauseReason: 'cap' }) })
    const view = renderList()
    await waitFor(() => { expect(chipOf('pooled')!.textContent).toContain('cap') })
    expect(chipOf('pooled')!.getAttribute('title')).toContain('raise its cap')
    view.unmount()

    installGoalLoopBridge({ pooled: loop({ phase: 'paused', pauseReason: 'error' }) })
    renderList()
    await waitFor(() => { expect(chipOf('pooled')!.textContent).toContain('error') })
    // Naming a control that is not there sends the user looking for a button
    // that does not exist.
    expect(chipOf('pooled')!.getAttribute('title')).not.toContain('raise its cap')
  })
})

describe('reads that resolve out of order (#1063 review finding 2)', () => {
  it('never lets an older read overwrite a newer one', async () => {
    // Pings arrive faster than the IPC resolves, so two reads are easily in
    // flight at once and nothing makes them land in order. An older read
    // landing last wrote a stale answer — and after a loop's FINAL ping there
    // is no later read to correct it, so the chip could stay wrong forever.
    const resolvers: Array<(value: Record<string, GoalLoopState>) => void> = []
    const readGoalLoops = vi.fn(() => new Promise<Record<string, GoalLoopState>>(resolve => { resolvers.push(resolve) }))
    const listeners = new Set<() => void>()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        readGoalLoops,
        onGoalLoopChanged: (listener: () => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    })

    renderList()
    await waitFor(() => { expect(resolvers).toHaveLength(1) })
    for (const listener of listeners) listener() // a second read, still in flight
    await waitFor(() => { expect(resolvers).toHaveLength(2) })

    // The NEWER read lands first…
    resolvers[1]!({ pooled: loop({ continuationsDelivered: 9 }) })
    await waitFor(() => { expect(chipOf('pooled')?.textContent).toContain('9/25') })

    // …and the older one lands after it. It must be discarded.
    resolvers[0]!({ pooled: loop({ continuationsDelivered: 8 }) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(chipOf('pooled')!.textContent).toContain('9/25')
  })

  it('drops a read that lands after unmount', async () => {
    const resolvers: Array<(value: Record<string, GoalLoopState>) => void> = []
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        readGoalLoops: vi.fn(() => new Promise<Record<string, GoalLoopState>>(resolve => { resolvers.push(resolve) })),
        onGoalLoopChanged: () => () => {},
      },
    })
    const view = renderList()
    await waitFor(() => { expect(resolvers).toHaveLength(1) })
    view.unmount()
    // No "update on an unmounted component" warning, and no throw.
    resolvers[0]!({ pooled: loop() })
    await new Promise(resolve => setTimeout(resolve, 0))
  })
})
