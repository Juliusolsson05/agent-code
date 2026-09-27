import { createWorkflowState } from 'workflow-mcp/state'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import {
  unavailableWorkflowClient,
  type WorkflowClient,
  type WorkflowRunReference,
} from '../client/WorkflowClient'
import { WorkflowClientProvider } from '../client/WorkflowClientContext'
import { WorkflowViewSelector } from './WorkflowViewSelector'

const references: WorkflowRunReference[] = [
  {
    runId: 'run-deep-hunt',
    status: 'running',
    workflow: { name: 'fat-bug-hunt', title: 'Deep hunt' },
  },
  {
    runId: 'run-review',
    status: 'completed',
    workflow: { name: 'review-findings' },
  },
]

function SelectionHarness(): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <>
      <div data-testid="session-viewport">
        {selected === null ? 'Conversation feed' : `Workflow viewport: ${selected}`}
      </div>
      <div data-testid="composer">Composer</div>
      <WorkflowViewSelector
        references={references}
        selectedRunId={selected}
        onSelect={setSelected}
      />
    </>
  )
}

describe('WorkflowViewSelector', () => {
  it('renders Main and workflows as vertical rows and swaps the selected session view', () => {
    render(<SelectionHarness />)

    const tabList = screen.getByRole('tablist')
    expect(tabList).toHaveAttribute('aria-orientation', 'vertical')
    expect(screen.getAllByRole('tab').map(tab => tab.textContent?.trim())).toEqual([
      '●Main',
      'Deep huntActive',
      'review-findingsInactive',
    ])
    expect(screen.getByRole('tab', { name: 'Main' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('session-viewport')).toHaveTextContent('Conversation feed')
    expect(screen.getByRole('tab', { name: /Deep hunt/ })).toHaveAttribute(
      'data-workflow-activity',
      'active',
    )
    expect(screen.getByRole('tab', { name: /Deep hunt/ })).toHaveClass('bg-accent/10')
    expect(screen.getByRole('tab', { name: /review-findings/ })).toHaveAttribute(
      'data-workflow-activity',
      'inactive',
    )
    expect(screen.getByRole('tab', { name: /review-findings/ })).toHaveClass('bg-surface-hi/35')

    fireEvent.click(screen.getByRole('tab', { name: /Deep hunt/ }))
    expect(screen.getByRole('tab', { name: /Deep hunt/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('session-viewport')).toHaveTextContent(
      'Workflow viewport: run-deep-hunt',
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Main' }))
    expect(screen.getByTestId('session-viewport')).toHaveTextContent('Conversation feed')
  })

  it('is one Tab stop that ↑/↓ walk, selecting as they go (ledger N7)', () => {
    render(<SelectionHarness />)
    const tabs = screen.getAllByRole('tab')
    // Only the selected view is tabbable, so Tab reaches the composer side
    // in one press instead of one per workflow.
    expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1, -1])

    tabs[0]!.focus()
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(tabs[1])
    expect(screen.getByTestId('session-viewport')).toHaveTextContent('Workflow viewport: run-deep-hunt')
    expect(screen.getAllByRole('tab').map(tab => tab.tabIndex)).toEqual([-1, 0, -1])

    fireEvent.keyDown(tabs[1]!, { key: 'End' })
    expect(document.activeElement).toBe(tabs[2])
    // Wraps from the last view back to Main.
    fireEvent.keyDown(tabs[2]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(tabs[0])
    expect(screen.getByTestId('session-viewport')).toHaveTextContent('Conversation feed')
  })

  it('keeps a Tab stop when the selected run is not listed', () => {
    // A selected run that dropped out of `references` (or has not arrived
    // yet) must not leave every row at tabIndex -1: the group would vanish
    // from the Tab order. Main is the fallback stop.
    render(<WorkflowViewSelector references={references} selectedRunId="run-gone" onSelect={vi.fn()} />)
    expect(screen.getAllByRole('tab').map(tab => tab.tabIndex)).toEqual([0, -1, -1])
  })

  it('keeps Show all out of the tablist but after it in Tab order', () => {
    render(<SelectionHarness />)
    const showAll = screen.getByRole('button', { name: 'Show All' })
    // tablist owns only tabs; the dialog opener used to sit between them.
    expect(screen.getByRole('tablist').contains(showAll)).toBe(false)
    const tabbables = [...document.querySelectorAll<HTMLElement>('button')].filter(el => el.tabIndex >= 0)
    expect(tabbables.at(-1)).toBe(showAll)
  })

  it('does not reserve empty chrome before a workflow is detected', () => {
    const onSelect = vi.fn()
    const { container } = render(
      <WorkflowViewSelector references={[]} selectedRunId={null} onSelect={onSelect} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('opens all session history and resolves authoritative timestamps and status on demand', async () => {
    const historyReferences: WorkflowRunReference[] = Array.from({ length: 5 }, (_, offset) => {
      const index = offset + 1
      return {
        runId: `run-${index}`,
        cwd: '/repo',
        status: index === 5 ? 'running' : 'completed',
        workflow: { name: `workflow-${index}` },
      }
    })
    const getSnapshot = vi.fn<WorkflowClient['getSnapshot']>(async ({ cwd, runId }) => {
      const index = Number(runId.slice('run-'.length))
      const status = index === 5 ? 'running' as const : 'completed' as const
      return {
        cwd,
        runId,
        cursor: index,
        manifest: {
          schemaVersion: 1,
          runId,
          cwd,
          workflow: { name: `workflow-${index}`, description: `Workflow ${index}` },
          status,
          cursor: index,
          createdAt: `2026-07-14T10:00:0${index}.000Z`,
          updatedAt: `2026-07-14T10:05:0${index}.000Z`,
        },
        state: createWorkflowState(runId),
      }
    })
    const client: WorkflowClient = {
      ...unavailableWorkflowClient,
      available: true,
      getSnapshot,
    }

    render(
      <WorkflowClientProvider value={client}>
        <WorkflowViewSelector
          references={historyReferences.slice(-3)}
          historyReferences={historyReferences}
          cwd="/repo"
          selectedRunId={null}
          onSelect={vi.fn()}
        />
      </WorkflowClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show All' }))
    expect(await screen.findByRole('dialog', { name: 'Workflow History' })).toBeInTheDocument()
    // Five dialog reads (one per history entry) plus the selector's single
    // check of the one tab that claims to be running (run-5), which is how a
    // tab learns its run is gone (#1440). Completed tabs are not checked.
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(6))
    expect(getSnapshot.mock.calls.filter(([scope]) => scope.runId === 'run-5')).toHaveLength(2)
    await waitFor(() => expect(screen.queryByText('Loading timestamps…')).not.toBeInTheDocument())

    expect(screen.getAllByRole('listitem')).toHaveLength(5)
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      expect.stringContaining('workflow-5'),
      expect.stringContaining('workflow-4'),
      expect.stringContaining('workflow-3'),
      expect.stringContaining('workflow-2'),
      expect.stringContaining('workflow-1'),
    ])
    expect(screen.getByText('Active · Running')).toBeInTheDocument()
    expect(screen.getAllByText('Inactive · Completed')).toHaveLength(4)
    expect(document.querySelector('time[datetime="2026-07-14T10:00:01.000Z"]'))
      .toBeInTheDocument()
    expect(document.querySelector('time[datetime="2026-07-14T10:05:05.000Z"]'))
      .toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Workflow history entries' })).toHaveFocus()
    expect(screen.getByRole('region', { name: 'Workflow history entries' }))
      .toHaveAttribute('tabindex', '0')
  })

  it('distinguishes a missing manifest from a failed detail read and retries the failure', async () => {
    const historyReferences: WorkflowRunReference[] = [
      { runId: 'run-missing', cwd: '/repo', status: 'queued', workflow: { name: 'missing' } },
      { runId: 'run-error', cwd: '/repo', status: 'running', workflow: { name: 'error' } },
      // No cwd of its own: still a global lookup by run id (#1440 review b).
      { runId: 'run-elsewhere', status: 'failed', workflow: { name: 'elsewhere' } },
    ]
    let errorAttempts = 0
    const getSnapshot = vi.fn<WorkflowClient['getSnapshot']>(async ({ cwd, runId }) => {
      if (runId === 'run-missing' || runId === 'run-elsewhere') return null
      errorAttempts += 1
      if (errorAttempts === 1) throw new Error('IPC unavailable')
      return {
        cwd,
        runId,
        cursor: 3,
        manifest: {
          schemaVersion: 1,
          runId,
          cwd,
          workflow: { name: 'error', description: 'Recovered detail read' },
          status: 'completed',
          cursor: 3,
          createdAt: '2026-07-14T10:00:03.000Z',
          updatedAt: '2026-07-14T10:00:03.000Z',
        },
        state: createWorkflowState(runId),
      }
    })
    const client: WorkflowClient = {
      ...unavailableWorkflowClient,
      available: true,
      getSnapshot,
    }

    render(
      <WorkflowClientProvider value={client}>
        <WorkflowViewSelector
          // The tabs show only the missing run: the selector reads what its
          // tabs claim is live, and run-error's read sequence belongs to the
          // dialog below.
          references={historyReferences.filter(reference => reference.runId === 'run-missing')}
          historyReferences={historyReferences}
          cwd="/repo"
          selectedRunId={null}
          onSelect={vi.fn()}
        />
      </WorkflowClientProvider>,
    )

    // #1440 reviews a+b: the TAB must agree with the dialog. A reference that
    // launched `queued` but whose run is gone is not Active.
    const missingTab = screen.getByRole('tab', { name: /missing/ })
    await waitFor(() => expect(missingTab).toHaveAttribute('data-workflow-activity', 'inactive'))
    expect(within(missingTab).getByLabelText('Status: Inactive (Expired)')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show All' }))
    await waitFor(() => expect(screen.queryByText('Loading timestamps…')).not.toBeInTheDocument())
    const historyList = screen.getByRole('list', { name: 'Previous workflow runs' })
    const missingRow = within(historyList).getByText('missing')
      .closest('[role="listitem"]') as HTMLElement
    const errorRow = within(historyList).getByText('error')
      .closest('[role="listitem"]') as HTMLElement
    // #1348: a run whose stored data is gone is expired and inactive, not a
    // fault, whatever its launch-time `queued` said. The lookup is global by
    // run id (review b), so a reference without its own cwd is expired too.
    expect(within(missingRow).getByText('Inactive · Expired')).toBeInTheDocument()
    expect(within(missingRow).getByText(/stored data is gone/)).toBeInTheDocument()
    const elsewhereRow = within(historyList).getByText('elsewhere')
      .closest('[role="listitem"]') as HTMLElement
    expect(within(elsewhereRow).getByText('Inactive · Expired')).toBeInTheDocument()
    expect(within(errorRow).getByText('Unknown · Status unavailable')).toBeInTheDocument()
    expect(within(errorRow).getByRole('alert')).toHaveTextContent('Could not load details.')

    fireEvent.click(within(errorRow).getByRole('button', { name: 'Retry' }))
    await waitFor(() => {
      expect(within(errorRow).getByText('Inactive · Completed')).toBeInTheDocument()
    })
    expect(getSnapshot.mock.calls.filter(([scope]) => scope.runId === 'run-error')).toHaveLength(2)
  })

  it('bounds history detail reads and incrementally mounts a large session history', async () => {
    const historyReferences: WorkflowRunReference[] = Array.from({ length: 500 }, (_, index) => ({
      runId: `run-${index}`,
      cwd: '/repo',
      status: 'completed',
      workflow: { name: `workflow-${index}` },
    }))
    const pending: Array<() => void> = []
    let active = 0
    let maxActive = 0
    const getSnapshot = vi.fn<WorkflowClient['getSnapshot']>(({ cwd, runId }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      return new Promise(resolve => {
        pending.push(() => {
          active -= 1
          resolve(null)
        })
      })
    })
    const client: WorkflowClient = {
      ...unavailableWorkflowClient,
      available: true,
      getSnapshot,
    }

    render(
      <WorkflowClientProvider value={client}>
        <WorkflowViewSelector
          references={historyReferences.slice(-3)}
          historyReferences={historyReferences}
          cwd="/repo"
          selectedRunId={null}
          onSelect={vi.fn()}
        />
      </WorkflowClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show All' }))
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(8))
    expect(maxActive).toBe(8)
    expect(screen.getAllByRole('listitem')).toHaveLength(50)
    expect(screen.getByText('Showing 50 of 500')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show 50 More' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(100)
    pending.splice(0, 8).forEach(resolve => resolve())
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(16))
    expect(maxActive).toBe(8)
  })

  // #1440 round-2 review b: the tab check must hold each run's answer on its
  // own. Batching every visible tab through one Promise.all let a later
  // transient failure clear a tab already proven Expired, and let one slow
  // read hold back another tab's answer.
  describe('selector expiry check', () => {
    const ref = (runId: string): WorkflowRunReference => ({ runId, cwd: '/repo', status: 'running', workflow: { name: runId } })
    const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(name) })
    const mount = (client: WorkflowClient, references: WorkflowRunReference[]) => (
      <WorkflowClientProvider value={client}>
        <WorkflowViewSelector references={references} cwd="/repo" selectedRunId={null} onSelect={vi.fn()} />
      </WorkflowClientProvider>
    )

    it('keeps a proven Expired tab when a later check of it would fail, and asks each run once', async () => {
      const calls: string[] = []
      const client: WorkflowClient = {
        ...unavailableWorkflowClient,
        available: true,
        getSnapshot: vi.fn<WorkflowClient['getSnapshot']>(async ({ runId }) => {
          calls.push(runId)
          if (runId === 'run-a' && calls.filter(id => id === 'run-a').length > 1) throw new Error('IPC unavailable')
          if (runId === 'run-a') return null
          return { runId, cwd: '/repo', cursor: 0, state: createWorkflowState(runId) }
        }),
      }
      const { rerender } = render(mount(client, [ref('run-a')]))
      await waitFor(() => expect(tab('run-a')).toHaveAttribute('data-workflow-activity', 'inactive'))
      rerender(mount(client, [ref('run-a'), ref('run-b')]))
      await waitFor(() => expect(calls).toContain('run-b'))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(tab('run-a')).toHaveAttribute('data-workflow-activity', 'inactive')
      expect(calls.filter(id => id === 'run-a')).toHaveLength(1)
    })

    it('shows one tab expired while another tab\'s read is still pending', async () => {
      const client: WorkflowClient = {
        ...unavailableWorkflowClient,
        available: true,
        getSnapshot: vi.fn<WorkflowClient['getSnapshot']>(({ runId }) => runId === 'run-slow' ? new Promise(() => {}) : Promise.resolve(null)),
      }
      render(mount(client, [ref('run-slow'), ref('run-gone')]))
      await waitFor(() => expect(tab('run-gone')).toHaveAttribute('data-workflow-activity', 'inactive'))
      expect(tab('run-slow')).toHaveAttribute('data-workflow-activity', 'active')
    })
  })
})

