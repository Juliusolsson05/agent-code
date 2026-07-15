import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { WorkflowRunReference } from '../client/WorkflowClient'
import { WorkflowViewSelector } from './WorkflowViewSelector'

const references: WorkflowRunReference[] = [
  {
    runId: 'run-deep-hunt',
    workflow: { name: 'fat-bug-hunt', title: 'Deep hunt' },
  },
  {
    runId: 'run-review',
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
      'Deep hunt',
      'review-findings',
    ])
    expect(screen.getByRole('tab', { name: 'Main' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('session-viewport')).toHaveTextContent('Conversation feed')

    fireEvent.click(screen.getByRole('tab', { name: 'Deep hunt' }))
    expect(screen.getByRole('tab', { name: 'Deep hunt' })).toHaveAttribute('aria-selected', 'true')
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
})
