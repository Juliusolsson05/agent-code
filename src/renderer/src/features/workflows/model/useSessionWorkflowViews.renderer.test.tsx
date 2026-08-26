import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import {
  unavailableWorkflowClient,
  type WorkflowClient,
  type WorkflowRunReference,
  type WorkflowSessionRunsSnapshot,
} from '../client/WorkflowClient'
import { WorkflowClientProvider } from '../client/WorkflowClientContext'
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

  it('lets an authoritative transport push supersede an optimistic resume replacement', async () => {
    let publishSessionRuns: ((snapshot: WorkflowSessionRunsSnapshot) => void) | null = null
    const client: WorkflowClient = {
      ...unavailableWorkflowClient,
      available: true,
      async listSessionRuns() {
        return []
      },
      subscribeSessionRuns(listener) {
        publishSessionRuns = listener
        return () => {
          publishSessionRuns = null
        }
      },
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WorkflowClientProvider value={client}>{children}</WorkflowClientProvider>
    )
    const { result } = renderHook(() => useSessionWorkflowViews({
      sessionId: 'session-resume',
      cwd: '/repo',
      transcriptReferences: [{ runId: 'run-parent', status: 'interrupted', cursor: 4 }],
    }), { wrapper })
    await waitFor(() => expect(publishSessionRuns).not.toBeNull())

    act(() => result.current.replaceReference({
      runId: 'run-child',
      resumedFromRunId: 'run-parent',
      status: 'queued',
      cursor: 1,
    }))
    expect(result.current.references).toEqual([
      expect.objectContaining({ runId: 'run-child', status: 'queued', cursor: 1 }),
    ])

    act(() => publishSessionRuns!({
      sessionId: 'session-resume',
      cwd: '/repo',
      runs: [{
        runId: 'run-child',
        resumedFromRunId: 'run-parent',
        status: 'completed',
        cursor: 8,
      }],
    }))

    expect(result.current.allReferences).toEqual([
      expect.objectContaining({ runId: 'run-child', status: 'completed', cursor: 8 }),
    ])
    expect(result.current.references).toEqual([
      expect.objectContaining({ runId: 'run-child', status: 'completed', cursor: 8 }),
    ])
  })
})
