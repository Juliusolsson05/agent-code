import { createWorkflowState } from 'workflow-mcp/state'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  })
})
