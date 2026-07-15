import { describe, expect, it, vi } from 'vitest'
import type {
  StoredWorkflowEvent,
  WorkflowRunSnapshot,
  WorkflowService,
} from 'workflow-mcp'

vi.mock('@main/window/mainWindow.js', () => ({
  sendToMainWindow: vi.fn(),
}))

const { WorkflowBridge } = await import('@main/workflows/WorkflowBridge.js')

function stored(runId: string, cursor: number): StoredWorkflowEvent {
  return {
    runId,
    cursor,
    recordedAt: `2026-07-14T00:00:0${cursor}.000Z`,
    event: {
      schemaVersion: 1,
      type: 'log',
      runId,
      sequence: cursor,
      eventId: `${runId}:${cursor}`,
      timestamp: `2026-07-14T00:00:0${cursor}.000Z`,
      payload: {
        level: 'info',
        message: {
          preview: `event ${cursor}`,
          lineCount: 1,
          content: `event ${cursor}`,
        },
      },
    },
  }
}

describe('WorkflowBridge', () => {
  it('coalesces one service subscription into cursor-bounded per-run batches', () => {
    vi.useFakeTimers()
    let listener: ((event: StoredWorkflowEvent) => void) | null = null
    const unsubscribe = vi.fn()
    const service = {
      subscribe: vi.fn((next: (event: StoredWorkflowEvent) => void) => {
        listener = next
        return unsubscribe
      }),
    } as unknown as WorkflowService
    const send = vi.fn()
    const bridge = new WorkflowBridge(service, { send, batchWindowMs: 16 })

    bridge.start()
    bridge.start()
    expect(service.subscribe).toHaveBeenCalledTimes(1)

    listener!(stored('run-a', 1))
    listener!(stored('run-b', 1))
    listener!(stored('run-a', 2))
    expect(send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(16)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith('workflows:event-batch', {
      runId: 'run-a',
      fromCursor: 1,
      toCursor: 2,
      events: [stored('run-a', 1), stored('run-a', 2)],
    })
    expect(send).toHaveBeenCalledWith('workflows:event-batch', {
      runId: 'run-b',
      fromCursor: 1,
      toCursor: 1,
      events: [stored('run-b', 1)],
    })

    bridge.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('passes explicit renderer cwd scope to snapshot, cursor, cancel, and resume', async () => {
    const snapshot = {
      manifest: { runId: 'run-a' },
      state: { runId: 'run-a' },
      cursor: 7,
    } as unknown as WorkflowRunSnapshot
    const service = {
      subscribe: () => () => undefined,
      snapshot: vi.fn(async () => snapshot),
      readEvents: vi.fn(async () => ({
        runId: 'run-a',
        cwd: '/repo',
        fromCursor: 7,
        toCursor: 8,
        events: [stored('run-a', 8)],
        hasMore: false,
      })),
      cancel: vi.fn(async () => undefined),
      resume: vi.fn(async () => ({
        runId: 'run-b',
        status: 'queued',
        workflow: { name: 'hunt' },
        cursor: 0,
        resumedFromRunId: 'run-a',
      })),
    } as unknown as WorkflowService
    const bridge = new WorkflowBridge(service, { send: vi.fn() })

    await expect(bridge.getSnapshot({ cwd: '/repo', runId: 'run-a' })).resolves.toEqual({
      cwd: '/repo',
      runId: 'run-a',
      cursor: 7,
      manifest: snapshot.manifest,
      state: snapshot.state,
    })
    await bridge.readEvents({ cwd: '/repo', runId: 'run-a', after: 7, limit: 10 })
    await bridge.cancel({ cwd: '/repo', runId: 'run-a', reason: 'user request' })
    await expect(bridge.resume({ cwd: '/repo', runId: 'run-a' })).resolves.toEqual({
      ok: true,
      run: {
        runId: 'run-b',
        status: 'queued',
        workflow: { name: 'hunt' },
        cursor: 0,
        resumedFromRunId: 'run-a',
      },
    })

    const scope = { cwd: '/repo', clientId: 'agent-code-renderer' }
    expect(service.snapshot).toHaveBeenCalledWith(scope, 'run-a')
    expect(service.readEvents).toHaveBeenCalledWith(scope, {
      runId: 'run-a',
      after: 7,
      limit: 10,
    })
    expect(service.cancel).toHaveBeenCalledWith(scope, 'run-a', 'user request')
    expect(service.resume).toHaveBeenCalledWith(scope, { runId: 'run-a' })
  })

  it('rejects malformed cursor requests before reaching the durable service', async () => {
    const service = {
      subscribe: () => () => undefined,
      readEvents: vi.fn(),
    } as unknown as WorkflowService
    const bridge = new WorkflowBridge(service, { send: vi.fn() })

    await expect(bridge.readEvents({
      cwd: '/repo',
      runId: 'run-a',
      after: -1,
    })).rejects.toThrow('after must be a non-negative integer')
    expect(service.readEvents).not.toHaveBeenCalled()
  })
})
