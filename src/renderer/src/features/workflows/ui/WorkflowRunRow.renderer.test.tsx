import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  createWorkflowState,
  reduceWorkflowState,
  type WorkflowEvent,
  type WorkflowState,
} from 'workflow-mcp/state'

import type { WorkflowClient } from '../client/WorkflowClient'
import { WorkflowClientProvider } from '../client/WorkflowClientContext'
import { WorkflowRunView } from './WorkflowRunRow'

function event(
  sequence: number,
  body: Partial<WorkflowEvent> & Pick<WorkflowEvent, 'type' | 'payload'>,
): WorkflowEvent {
  return {
    schemaVersion: 1,
    runId: 'run-ui',
    sequence,
    eventId: `event-${sequence}`,
    timestamp: `2026-07-14T10:00:${String(sequence).padStart(2, '0')}.000Z`,
    ...body,
  } as WorkflowEvent
}

function completedState(): WorkflowState {
  const events: WorkflowEvent[] = [
    event(1, {
      type: 'run.started',
      payload: {
        workflow: {
          name: 'fat-bug-hunt',
          title: 'Deep multi-agent hunt',
          description: 'Find, deduplicate, and verify bugs',
        },
      },
    }),
    event(2, {
      type: 'phase.discovered',
      phaseId: 'find',
      payload: { title: 'Find', detail: 'Search every subsystem', source: 'metadata' },
    }),
    event(3, {
      type: 'agent.admitted',
      phaseId: 'find',
      agentId: 'agent-main',
      payload: {
        callIndex: 0,
        label: 'find:main-sessions',
        prompt: { preview: 'Inspect main sessions', lineCount: 1, content: 'Inspect main sessions' },
        options: {},
        cacheKey: 'main',
      },
    }),
    event(4, {
      type: 'agent.started',
      phaseId: 'find',
      agentId: 'agent-main',
      attemptId: 'attempt-main',
      payload: { attemptNumber: 1, source: 'live', provider: 'codex' },
    }),
    event(5, {
      type: 'agent.activity.started',
      phaseId: 'find',
      agentId: 'agent-main',
      attemptId: 'attempt-main',
      payload: {
        activity: {
          activityId: 'command-1',
          kind: 'command',
          title: 'rg "spawn" src/main',
          content: { preview: '3 matches', lineCount: 1, content: '3 matches' },
        },
      },
    }),
    event(6, {
      type: 'agent.activity.completed',
      phaseId: 'find',
      agentId: 'agent-main',
      attemptId: 'attempt-main',
      payload: { activityId: 'command-1' },
    }),
    event(7, {
      type: 'agent.completed',
      phaseId: 'find',
      agentId: 'agent-main',
      attemptId: 'attempt-main',
      payload: {
        source: 'live',
        structured: false,
        result: { preview: 'Found an orphan process', lineCount: 1, content: 'Found an orphan process' },
      },
    }),
    event(8, {
      type: 'agent.admitted',
      phaseId: 'find',
      agentId: 'agent-renderer',
      payload: {
        callIndex: 1,
        label: 'find:renderer',
        prompt: { preview: 'Inspect renderer', lineCount: 1, content: 'Inspect renderer' },
        options: {},
        cacheKey: 'renderer',
      },
    }),
    event(9, {
      type: 'agent.reused',
      phaseId: 'find',
      agentId: 'agent-renderer',
      payload: {
        source: 'journal',
        structured: false,
        result: { preview: 'Cached finding', lineCount: 1, content: 'Cached finding' },
      },
    }),
    event(10, {
      type: 'run.completed',
      payload: { result: { preview: '2 findings', lineCount: 1, content: '2 findings' } },
    }),
  ]
  return events.reduce(reduceWorkflowState, createWorkflowState('run-ui'))
}

function providerBlockedState(): WorkflowState {
  const events: WorkflowEvent[] = [
    event(1, {
      type: 'run.started',
      payload: { workflow: { name: 'provider-recovery', title: 'Provider recovery' } },
    }),
    event(2, {
      type: 'agent.admitted',
      agentId: 'agent-blocked',
      payload: {
        callIndex: 0,
        label: 'resume historical review',
        prompt: { preview: 'Continue', lineCount: 1, content: 'Continue' },
        options: {},
        cacheKey: 'blocked',
      },
    }),
    event(3, {
      type: 'agent.queued',
      agentId: 'agent-blocked',
      attemptId: 'attempt-2',
      payload: {
        reason: 'Waiting for codex provider health probe',
      },
    }),
  ]
  return events.reduce(reduceWorkflowState, createWorkflowState('run-ui'))
}

function clientFor(state: WorkflowState): WorkflowClient {
  return {
    available: true,
    async getSnapshot() {
      return { runId: 'run-ui', cwd: '/repo', cursor: state.sequence, state }
    },
    async readEvents(scope) {
      return {
        runId: scope.runId,
        cwd: scope.cwd,
        fromCursor: scope.after,
        toCursor: scope.after,
        events: [],
        hasMore: false,
      }
    },
    subscribe() { return () => {} },
    acknowledge() {},
    async cancel() {},
    async resume() { return { runId: 'run-resumed', cwd: '/repo' } },
    async listSessionRuns() { return [] },
    subscribeSessionRuns() { return () => {} },
  }
}

describe('WorkflowRunView', () => {
  it('shows why admitted work is queued instead of presenting circuit recovery as idle capacity', async () => {
    const state = providerBlockedState()
    render(
      <WorkflowClientProvider value={clientFor(state)}>
        <WorkflowRunView
          reference={{ runId: 'run-ui' }}
          cwd="/repo"
          onReferenceChange={() => {}}
        />
      </WorkflowClientProvider>,
    )

    expect(await screen.findByText('Waiting for codex provider health probe')).toBeInTheDocument()
  })

  it('renders phases and agents vertically and expands only the selected agent inline', async () => {
    const state = completedState()
    render(
      <WorkflowClientProvider value={clientFor(state)}>
        <WorkflowRunView
          reference={{ runId: 'run-ui' }}
          cwd="/repo"
          onReferenceChange={() => {}}
        />
      </WorkflowClientProvider>,
    )

    expect(await screen.findByText('Deep multi-agent hunt')).toBeInTheDocument()
    expect(screen.getByText('Find')).toBeInTheDocument()
    expect(screen.getByText('find:main-sessions')).toBeInTheDocument()
    expect(screen.getByText('find:renderer')).toBeInTheDocument()
    expect(document.querySelectorAll('[data-workflow-agent-id]')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: /find:main-sessions/i }))
    expect(screen.getByText('Inspect main sessions')).toBeInTheDocument()
    expect(screen.getByText('rg "spawn" src/main')).toBeInTheDocument()
    expect(screen.queryByText('3 matches')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /command.*rg "spawn" src\/main/i }))
    expect(screen.getByText('3 matches')).toBeInTheDocument()
    expect(screen.getByText('Found an orphan process')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /find:renderer/i }))
    await waitFor(() => expect(screen.queryByText('Inspect main sessions')).not.toBeInTheDocument())
    expect(screen.getByText('Inspect renderer')).toBeInTheDocument()
    expect(screen.getByText('Completed · cached')).toBeInTheDocument()
  })
})
