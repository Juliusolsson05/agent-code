import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { WorkflowRunReference } from '../client/WorkflowClient'
import { useSessionWorkflowViews } from './useSessionWorkflowViews'

function reference(index: number): WorkflowRunReference {
  return {
    runId: `run-${index}`,
    workflow: { name: `workflow-${index}` },
  }
}

describe('useSessionWorkflowViews', () => {
  it('keeps only the three newest workflow lineages and returns to Main when one ages out', async () => {
    const initialReferences = [1, 2, 3, 4, 5].map(reference)
    const { result, rerender } = renderHook(
      ({ references }: { references: WorkflowRunReference[] }) => useSessionWorkflowViews({
        sessionId: 'session-with-history',
        // No cwd keeps this projection test independent of Electron IPC. The transcript is the
        // durable discovery plane that actually reproduces the overflowing historical stack.
        cwd: null,
        transcriptReferences: references,
      }),
      { initialProps: { references: initialReferences } },
    )

    expect(result.current.references.map(candidate => candidate.runId)).toEqual([
      'run-3',
      'run-4',
      'run-5',
    ])
    expect(result.current.allReferences.map(candidate => candidate.runId)).toEqual([
      'run-1',
      'run-2',
      'run-3',
      'run-4',
      'run-5',
    ])

    act(() => result.current.selectRun('run-3'))
    expect(result.current.selectedRunId).toBe('run-3')

    rerender({ references: [...initialReferences, reference(6)] })

    expect(result.current.references.map(candidate => candidate.runId)).toEqual([
      'run-4',
      'run-5',
      'run-6',
    ])
    expect(result.current.allReferences).toHaveLength(6)
    await waitFor(() => expect(result.current.selectedRunId).toBeNull())
  })
})
