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

const row = (sessionId: string, index: number): DispatchAgentRow => ({
  key: `project:${sessionId}`, label: `A${index}`, globalIndex: index,
  tabId: 'project', tabTitle: 'Project', tabIndex: 0, sessionId,
  kind: 'claude', title: sessionId, depth: 0,
})
const rows = [row('placed', 1), row('pooled', 2)]

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

const renderList = () => render(<DispatchAgentList
  groups={[{ tab: { id: 'project', title: 'Project' }, tabIndex: 0, rows }]}
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
