import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as workspaceQueries from '@renderer/workspace/queries'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { WorkspaceState } from '@renderer/workspace/types'

import { NewAgentInDialog } from './NewAgentInDialog'

afterEach(() => {
  vi.restoreAllMocks()
})

// Three projects in Grid Dispatch. The focused lane (2) is EMPTY and the classic
// Dispatch focus is B's agent — the exact situation that used to force the
// "go select an agent in the right project first" detour. Plain New Agent…
// would therefore target project B.
function workspaceState(): WorkspaceState {
  return {
    tabs: [
      { id: 'tabA', title: 'project-a', root: { type: 'leaf', sessionId: 'a1' }, focusedSessionId: 'a1' },
      { id: 'tabB', title: 'project-b', root: { type: 'leaf', sessionId: 'b1' }, focusedSessionId: 'b1' },
      { id: 'tabC', title: 'project-c', root: { type: 'leaf', sessionId: 'c1' }, focusedSessionId: 'c1' },
    ],
    activeTabId: 'tabA',
    dispatchMode: {
      scope: 'global',
      focusedSessionId: 'b1',
      tiled: {
        focusedLane: 2,
        lanes: [{ selectedSessionId: 'a1' }, { selectedSessionId: 'b1' }, {}],
      },
    },
    sessions: {
      a1: { cwd: '/work/project-a', kind: 'claude' },
      b1: { cwd: '/work/project-b', kind: 'codex' },
      c1: { cwd: '/work/project-c', kind: 'claude' },
    },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
  }
}

function harness(options: { open?: boolean; state?: WorkspaceState } = {}) {
  const createDetachedDispatchAgent = vi.fn(async () => 'new-agent')
  const onClose = vi.fn()
  const workspace = {
    state: options.state ?? workspaceState(),
    createDetachedDispatchAgent,
  } as unknown as Workspace
  const mounted = render(
    <NewAgentInDialog open={options.open ?? true} workspace={workspace} onClose={onClose} />,
  )
  const dialog = () => screen.getByRole('dialog')
  const press = (key: string) => fireEvent.keyDown(dialog(), { key })
  return { createDetachedDispatchAgent, onClose, mounted, workspace, press }
}

describe('NewAgentInDialog', () => {
  it('Enter, Enter creates the default agent in the project plain New Agent would have used', () => {
    // Accepting both defaults lands in New Agent…'s own target PROJECT (B
    // here). The directory is B's own checkout by design — see anchorFor.
    const { createDetachedDispatchAgent, onClose, press } = harness()

    press('Enter')
    press('Enter')

    expect(onClose).toHaveBeenCalledOnce()
    expect(createDetachedDispatchAgent).toHaveBeenCalledWith(
      { kind: 'claude', providerRuntime: undefined },
      { tabId: 'tabB', anchorSessionId: 'b1' },
    )
  })

  it('creates the chosen agent in the chosen project from the keyboard, without selecting an agent in that project first', () => {
    const { createDetachedDispatchAgent, press } = harness()

    press('ArrowDown') // Claude -> Codex
    press('Enter')
    expect(screen.getByText('C · project-c')).toBeInTheDocument()
    press('ArrowDown') // B (initial) -> C
    press('Enter')

    expect(createDetachedDispatchAgent).toHaveBeenCalledWith(
      { kind: 'codex', providerRuntime: undefined },
      { tabId: 'tabC', anchorSessionId: 'c1' },
    )
  })

  it('keeps OpenCode Terminal a distinct runtime choice on the mouse path', () => {
    const { createDetachedDispatchAgent } = harness()

    fireEvent.click(screen.getByText('OpenCode Terminal').closest('button')!)
    fireEvent.click(screen.getByText('A · project-a').closest('button')!)

    expect(createDetachedDispatchAgent).toHaveBeenCalledWith(
      { kind: 'opencode', providerRuntime: 'terminal' },
      { tabId: 'tabA', anchorSessionId: 'a1' },
    )
  })

  it('Backspace on the project step goes back to the agent step without creating anything', () => {
    const { createDetachedDispatchAgent, press } = harness()

    press('Enter')
    expect(screen.queryByText('Codex')).not.toBeInTheDocument()
    press('Backspace')

    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(createDetachedDispatchAgent).not.toHaveBeenCalled()
  })

  it('shows a project it cannot anchor as disabled, and neither click nor arrows can choose it', () => {
    const state = workspaceState()
    delete state.sessions.c1
    const { createDetachedDispatchAgent, press } = harness({ state })

    press('Enter')
    expect(screen.getByText(/no agent in this project/i)).toBeInTheDocument()
    // The native attribute, not just the commit guard: it is what assistive
    // tech announces as unavailable, and the click assertion below would pass
    // on the guard alone.
    expect(screen.getByText('C · project-c').closest('button')).toBeDisabled()
    fireEvent.click(screen.getByText('C · project-c').closest('button')!)
    expect(createDetachedDispatchAgent).not.toHaveBeenCalled()

    // From B, the only row below is the disabled C: the highlight must stay on
    // B rather than parking on a row Enter cannot act on.
    press('ArrowDown')
    press('Enter')
    expect(createDetachedDispatchAgent).toHaveBeenCalledWith(
      { kind: 'claude', providerRuntime: undefined },
      { tabId: 'tabB', anchorSessionId: 'b1' },
    )
  })

  it('cannot create a second agent from a repeated Enter while the first spawn is in flight', () => {
    // The dialog's `open` prop only drops after the parent reacts to onClose;
    // until then a fast double Enter would otherwise spawn twice.
    const { createDetachedDispatchAgent, press } = harness()

    press('Enter')
    press('Enter')
    press('Enter')

    expect(createDetachedDispatchAgent).toHaveBeenCalledOnce()
  })

  it('leaves Enter to a focused footer button instead of advancing or creating', () => {
    // A focused button owns its own Enter (components/ui/dialog-actions.tsx).
    // Before this guard, Tab to Cancel + Enter on the project step SPAWNED an
    // agent: the list handler prevented the button's native click and then
    // committed the highlighted row. `fireEvent` returning true means the
    // default was not prevented, so the real browser's click still happens.
    const { createDetachedDispatchAgent, press } = harness()

    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Enter' })).toBe(true)
    expect(screen.getByText('Codex')).toBeInTheDocument() // still on the agent step

    press('Enter')
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Back' }), { key: 'Enter' })).toBe(true)
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Enter' })).toBe(true)

    expect(createDetachedDispatchAgent).not.toHaveBeenCalled()
  })

  it('ignores a held Enter, so one long press cannot pick the agent and spawn in the same breath', () => {
    const { createDetachedDispatchAgent, press } = harness()

    press('Enter')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter', repeat: true })

    expect(createDetachedDispatchAgent).not.toHaveBeenCalled()
  })

  it('never lets keyboard focus rest on a list row, on either step', () => {
    // Rows are buttons (so a click works), but they must not be tab stops.
    // A Tab-focused row kept DOM focus while the arrows moved the highlight,
    // so Space — which the browser delivers as a click on the FOCUSED button —
    // created the agent in a project other than the highlighted one (and, on
    // step one, picked a different agent). happy-dom does not synthesize a
    // keyboard click, so the honest pin is the structure that makes the bug
    // impossible: no row can receive keyboard focus.
    const { press } = harness()

    const agentRows = document.querySelectorAll('[data-new-agent-in-choice]')
    expect(agentRows.length).toBeGreaterThan(0)
    agentRows.forEach(row => expect(row).toHaveAttribute('tabindex', '-1'))

    press('Enter')
    const projectRows = document.querySelectorAll('[data-new-agent-in-project]')
    expect(projectRows.length).toBe(3)
    projectRows.forEach(row => expect(row).toHaveAttribute('tabindex', '-1'))
  })

  it('reopens on the agent step without ever mounting the previous project step, and with a fresh latch', () => {
    // Resetting on OPEN also ends on the agent step — but only after first
    // mounting the stale project step for one render, which a non-user-event
    // open (an MCP commands.run) can paint. Watching the DOM during the reopen
    // is what tells reset-on-close apart from reset-on-open.
    const { createDetachedDispatchAgent, mounted, workspace, onClose, press } = harness()

    press('Enter')
    press('Enter') // commits and latches, leaving the dialog on the project step
    mounted.rerender(<NewAgentInDialog open={false} workspace={workspace} onClose={onClose} />)

    const observer = new MutationObserver(() => {})
    observer.observe(document.body, { childList: true, subtree: true })
    mounted.rerender(<NewAgentInDialog open workspace={workspace} onClose={onClose} />)
    // Scan REMOVED nodes too. `rerender` runs inside act(), so by the time the
    // records are read, reset-on-open has already replaced the stale project
    // rows — an added portal root no longer contains them. The replaced rows
    // themselves, though, appear in `removedNodes` with their attributes
    // intact, which is the evidence that the stale step was mounted.
    const isProjectRowTree = (node: Node) =>
      node instanceof Element &&
      (node.matches('[data-new-agent-in-project]') || node.querySelector('[data-new-agent-in-project]') !== null)
    const staleProjectStepMounted = observer.takeRecords().some(record =>
      Array.from(record.addedNodes).some(isProjectRowTree) ||
      Array.from(record.removedNodes).some(isProjectRowTree),
    )
    observer.disconnect()

    expect(staleProjectStepMounted).toBe(false)
    expect(screen.getByText('Codex')).toBeInTheDocument()
    press('Enter')
    press('Enter')
    expect(createDetachedDispatchAgent).toHaveBeenCalledTimes(2)
  })

  it('says so when every project the focused row is bound to has been closed', () => {
    // Closing a tab does not yet clear row bindings in memory (#863), so a row
    // can be bound only to projects that no longer exist. "No projects are
    // open" would be false — other projects are — and gives no way forward.
    const state = workspaceState()
    state.dispatchMode!.tiled!.rows = [{ length: 3, projectTabIds: ['tab-closed'] }]
    const { press } = harness({ state })

    press('Enter')

    expect(screen.getByText(/none of this row.s projects are open/i)).toBeInTheDocument()
    expect(screen.getByText(/row projects/i)).toBeInTheDocument()
  })

  it('Cancel closes without creating whichever row is highlighted', () => {
    const { createDetachedDispatchAgent, onClose, press } = harness()

    press('Enter')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(createDetachedDispatchAgent).not.toHaveBeenCalled()
  })

  it('derives no project list while closed', () => {
    // The surface is always mounted and re-renders with every workspace change;
    // building the list walks every tab's sessions and the Dispatch rows, which
    // is pure waste for a dialog nobody can see.
    const enumerateSessions = vi.spyOn(workspaceQueries, 'resolveTabSessions')
    const { mounted, workspace, onClose } = harness({ open: false })

    expect(enumerateSessions).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    mounted.rerender(<NewAgentInDialog open workspace={workspace} onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(enumerateSessions).toHaveBeenCalled()
  })
})
