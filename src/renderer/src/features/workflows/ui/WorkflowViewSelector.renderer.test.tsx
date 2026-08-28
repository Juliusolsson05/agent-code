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

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(await screen.findByRole('dialog', { name: 'Workflow history' })).toBeInTheDocument()
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(5))
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
    ]
    let errorAttempts = 0
    const getSnapshot = vi.fn<WorkflowClient['getSnapshot']>(async ({ cwd, runId }) => {
      if (runId === 'run-missing') return null
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
          references={historyReferences}
          historyReferences={historyReferences}
          cwd="/repo"
          selectedRunId={null}
          onSelect={vi.fn()}
        />
      </WorkflowClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    await waitFor(() => expect(screen.queryByText('Loading timestamps…')).not.toBeInTheDocument())
    const historyList = screen.getByRole('list', { name: 'Previous workflow runs' })
    const missingRow = within(historyList).getByText('missing')
      .closest('[role="listitem"]') as HTMLElement
    const errorRow = within(historyList).getByText('error')
      .closest('[role="listitem"]') as HTMLElement
    expect(within(missingRow).getByText('Unknown · Status unavailable')).toBeInTheDocument()
    expect(within(missingRow).getByText('Timestamp unavailable')).toBeInTheDocument()
    expect(within(errorRow).getByText('Unknown · Status unavailable')).toBeInTheDocument()
    expect(within(errorRow).getByRole('alert')).toHaveTextContent('Couldn’t load details')

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

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(8))
    expect(maxActive).toBe(8)
    expect(screen.getAllByRole('listitem')).toHaveLength(50)
    expect(screen.getByText('Showing 50 of 500')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(100)
    pending.splice(0, 8).forEach(resolve => resolve())
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(16))
    expect(maxActive).toBe(8)
  })
})
