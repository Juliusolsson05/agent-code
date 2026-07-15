import { describe, expect, it, vi } from 'vitest'
import {
  createWorkflowState,
  reduceWorkflowState,
  type StoredWorkflowEvent,
  type WorkflowEvent,
} from 'workflow-mcp/state'

import type {
  WorkflowClient,
  WorkflowEventBatch,
  WorkflowEventPage,
} from '../client/WorkflowClient'
import { WorkflowRunStore } from './workflowRunStore'

function event(
  sequence: number,
  body: Partial<WorkflowEvent> & Pick<WorkflowEvent, 'type' | 'payload'>,
): WorkflowEvent {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    sequence,
    eventId: `event-${sequence}`,
    timestamp: `2026-07-14T10:00:0${sequence}.000Z`,
    ...body,
  } as WorkflowEvent
}

const events = [
  event(1, {
    type: 'run.started',
    payload: { workflow: { name: 'fat-bug-hunt', description: 'Deep hunt' } },
  }),
  event(2, {
    type: 'phase.discovered',
    phaseId: 'find',
    payload: { title: 'Find', source: 'metadata' },
  }),
  event(3, {
    type: 'agent.admitted',
    phaseId: 'find',
    agentId: 'agent-1',
    payload: {
      callIndex: 0,
      label: 'find:main',
      prompt: { preview: 'Find bugs', lineCount: 1, content: 'Find bugs' },
      options: {},
      cacheKey: 'cache-1',
    },
  }),
  event(4, {
    type: 'agent.queued',
    phaseId: 'find',
    agentId: 'agent-1',
    payload: {},
  }),
]

function stored(...items: WorkflowEvent[]): StoredWorkflowEvent[] {
  return items.map(item => ({
    runId: item.runId,
    cursor: item.sequence,
    recordedAt: item.timestamp,
    event: item,
  }))
}

class FakeWorkflowClient implements WorkflowClient {
  available = true
  listener: ((batch: WorkflowEventBatch) => void) | null = null
  readEvents = vi.fn<(request: { cwd: string; runId: string; after: number }) => Promise<WorkflowEventPage>>()
  private initial = reduceWorkflowState(createWorkflowState('run-1'), events[0])

  async getSnapshot() {
    return { runId: 'run-1', cwd: '/repo', cursor: 1, state: this.initial }
  }
  subscribe(listener: (batch: WorkflowEventBatch) => void) {
    this.listener = listener
    return () => { this.listener = null }
  }
  async cancel() {}
  async resume() { return { runId: 'run-2', cwd: '/repo' } }
  emit(batch: WorkflowEventBatch) { this.listener?.(batch) }
}

async function eventually(assertion: () => void): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    try {
      assertion()
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  assertion()
}

describe('WorkflowRunStore', () => {
  it('applies a contiguous pushed event once', async () => {
    const client = new FakeWorkflowClient()
    const store = new WorkflowRunStore(client, { cwd: '/repo', runId: 'run-1' })
    const stop = store.subscribe(() => {})
    await eventually(() => expect(store.getSnapshot().cursor).toBe(1))

    client.emit({
      runId: 'run-1',
      cwd: '/repo',
      fromCursor: 1,
      toCursor: 2,
      events: stored(events[1]),
    })
    await eventually(() => expect(store.getSnapshot().cursor).toBe(2))
    expect(client.readEvents).not.toHaveBeenCalled()
    stop()
  })

  it('repairs a coalesced push gap from durable events before reducing', async () => {
    const client = new FakeWorkflowClient()
    client.readEvents.mockResolvedValue({
      runId: 'run-1',
      cwd: '/repo',
      fromCursor: 1,
      toCursor: 4,
      events: stored(...events.slice(1)),
      hasMore: false,
    })
    const store = new WorkflowRunStore(client, { cwd: '/repo', runId: 'run-1' })
    const stop = store.subscribe(() => {})
    await eventually(() => expect(store.getSnapshot().cursor).toBe(1))

    client.emit({
      runId: 'run-1',
      cwd: '/repo',
      fromCursor: 3,
      toCursor: 4,
      events: stored(events[3]),
    })

    await eventually(() => expect(store.getSnapshot().cursor).toBe(4))
    expect(client.readEvents).toHaveBeenCalledWith({
      cwd: '/repo',
      runId: 'run-1',
      after: 1,
      limit: 500,
      waitMs: 0,
    })
    expect(store.getSnapshot().snapshot.agents[0]?.status).toBe('queued')
    stop()
  })

  it('buffers pushes received while the initial snapshot request is in flight', async () => {
    const client = new FakeWorkflowClient()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = client.getSnapshot.bind(client)
    client.getSnapshot = async () => {
      await gate
      return original()
    }
    const store = new WorkflowRunStore(client, { cwd: '/repo', runId: 'run-1' })
    const stop = store.subscribe(() => {})
    await eventually(() => expect(client.listener).not.toBeNull())
    client.emit({
      runId: 'run-1',
      cwd: '/repo',
      fromCursor: 1,
      toCursor: 2,
      events: stored(events[1]),
    })
    release()
    await eventually(() => expect(store.getSnapshot().cursor).toBe(2))
    stop()
  })
})
