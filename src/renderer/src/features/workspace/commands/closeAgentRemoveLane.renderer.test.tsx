import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommandContext } from '@renderer/features/command-palette/types'
import { layoutCommands } from '@renderer/features/workspace/commands/layoutCommands'
import { CloseConfirmationDialog } from '@renderer/features/workspace/ui/CloseConfirmationDialog'
import { __resetCloseConfirmationForTests } from '@renderer/workspace/closeConfirmationBroker'
import { useDispatchActions } from '@renderer/workspace/hook/actions/dispatch'
import { mountPaneActions } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// "Close Agent and Remove Lane" removes the focused lane only when closeSession
// resolves true. Since #886, `true` for a project's root carries a second
// meaning: the root closed AND a Dispatch row was promoted into the grid. These
// pin that the promotion never leaks into the layout mutation — the survivor
// keeps its own lane — and that declining leaves the layout untouched.
//
// Real pieces throughout: the palette command, the pane close action, the
// dispatch lane action and the confirmation dialog. Only the ownership-checked
// kill IPC is mocked.

const command = layoutCommands.find(candidate => candidate.id === 'close-agent-remove-lane')
if (!command) throw new Error('Close Agent and Remove Lane command is missing')

const killOwnedSession = vi.fn(async (_owner: { sessionId: string }) => true)
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
beforeEach(() => {
  killOwnedSession.mockClear()
  Object.defineProperty(window, 'api', { configurable: true, value: { killOwnedSession } })
})
afterEach(() => {
  __resetCloseConfirmationForTests()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function tiledProject(): WorkspaceState {
  return {
    tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'root' }, focusedSessionId: 'root' }],
    activeTabId: 'project',
    sessions: {
      root: { cwd: '/project', kind: 'claude', title: 'Root' },
      worker: { cwd: '/project', kind: 'codex', title: 'Worker' },
    },
    detachedSessions: {
      worker: { sessionId: 'worker', surface: 'dispatch', projectTabId: 'project', projectTabTitle: 'Project', projectTabIndex: 0, detachedAt: 1 },
    },
    // The root in lane 1 (focused), the detached worker in lane 2.
    dispatchMode: {
      scope: 'project',
      tiled: { lanes: [{ selectedSessionId: 'root' }, { selectedSessionId: 'worker' }], focusedLane: 0 },
    },
    gridRelatedSelections: {}, buried: [], pinnedSessionIds: [],
  }
}

function mount() {
  const harness = mountPaneActions(tiledProject())
  const dispatch = renderHook(() => useDispatchActions(
    harness.getState(), harness.setState, vi.fn(), vi.fn(), harness.refs, vi.fn(), vi.fn(),
  ))
  render(<CloseConfirmationDialog />)
  const workspace = {
    get state() { return harness.getState() },
    closeSession: harness.actions.closeSession,
    removeTiledLane: dispatch.result.current.removeTiledLane,
  } as unknown as Workspace
  return { harness, context: { workspace, ui: {}, flags: {} } as unknown as CommandContext }
}

const laneSessions = (state: WorkspaceState) =>
  state.dispatchMode?.tiled?.lanes.map(lane => lane.selectedSessionId)

async function runAndAnswer(context: CommandContext, button: string) {
  let running!: void | Promise<void>
  await act(async () => { running = command!.run(context) })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: button }))
    await running
  })
}

describe('Close Agent and Remove Lane on a project root (#886 review m8)', () => {
  it('Close Agent removes the root lane and leaves the other lane on the promoted worker', async () => {
    const { harness, context } = mount()
    expect(command.when?.(context)).toBe(true)
    await runAndAnswer(context, 'Close Agent')
    expect(killOwnedSession.mock.calls.map(([owner]) => owner.sessionId)).toEqual(['root'])
    expect(laneSessions(harness.getState())).toEqual(['worker'])
    expect(harness.getState().tabs[0].root).toEqual({ type: 'leaf', sessionId: 'worker' })
    expect(harness.getState().sessions.worker).toBeDefined()
  })

  it('Cancel leaves both lanes and both sessions', async () => {
    const { harness, context } = mount()
    await runAndAnswer(context, 'Cancel')
    expect(killOwnedSession).not.toHaveBeenCalled()
    expect(laneSessions(harness.getState())).toEqual(['root', 'worker'])
    expect(Object.keys(harness.getState().sessions)).toEqual(['root', 'worker'])
  })
})
