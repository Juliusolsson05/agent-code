import { describe, expect, it, vi } from 'vitest'
import type {
  StoredWorkflowEvent,
  WorkflowRunSnapshot,
  WorkflowService,
} from 'workflow-mcp'
import { createWorkflowState } from 'workflow-mcp/state'

// The bridge resolves a target window before sending. These tests exercise
// delivery bookkeeping (cursors, interests, batching), not routing, so the
// registry is stubbed to a single always-resolvable window — routing itself is
// covered in windowRegistry.routing.test.ts.
vi.mock('@main/window/windowRegistry.js', () => ({
  recordIpcDiagnosticBreadcrumb: vi.fn(),
  sendToWindow: vi.fn(),
  windowForSession: vi.fn(() => 'test-window'),
  windowIdForWebContentsId: vi.fn(() => 'test-window'),
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

function manifest(runId: string, cursor: number, cwd = '/repo') {
  return {
    schemaVersion: 1 as const,
    runId,
    cwd,
    workflow: { name: 'hunt', description: 'Find renderer bugs' },
    status: 'running' as const,
    cursor,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  }
}

describe('WorkflowBridge', () => {
  it('rehydrates an automatic successor into its original session lineage', async () => {
    const service = {
      subscribe: () => () => undefined,
      listStoredRunReferences: vi.fn(async () => ([
        {
          runId: 'run-parent',
          cwd: '/repo',
          clientId: 'session-1',
          status: 'interrupted',
          cursor: 10,
          workflow: { name: 'hunt', description: 'Find bugs' },
          transcriptDirectory: '/state/run-parent/transcripts',
        },
        {
          runId: 'run-successor',
          cwd: '/repo',
          clientId: 'session-1',
          status: 'running',
          cursor: 4,
          workflow: { name: 'hunt', description: 'Find bugs' },
          transcriptDirectory: '/state/run-successor/transcripts',
          resumedFromRunId: 'run-parent',
        },
      ])),
      cancel: vi.fn(async () => undefined),
    } as unknown as WorkflowService
    const bridge = new WorkflowBridge(service, { send: vi.fn() })

    await bridge.start()

    expect(bridge.getSessionRuns({ sessionId: 'session-1', cwd: '/repo' }).runs).toEqual([
      expect.objectContaining({ runId: 'run-successor', resumedFromRunId: 'run-parent' }),
    ])
    await bridge.cancel({ cwd: '/repo', runId: 'run-successor' })
    expect(service.cancel).toHaveBeenCalledWith(
      { cwd: '/repo', clientId: 'agent-code-renderer' },
      'run-successor',
      undefined,
    )
  })

  it('collapses reverse-ordered multi-hop recovery lineage to one leaf', async () => {
    const base = {
      cwd: '/repo',
      clientId: 'session-1',
      status: 'interrupted' as const,
      cursor: 1,
      workflow: { name: 'hunt', description: 'Find bugs' },
      transcriptDirectory: '/state/transcripts',
    }
    const service = {
      subscribe: () => () => undefined,
      // Newest-first is intentionally hostile to the tempting parent-first slot algorithm.
      listStoredRunReferences: vi.fn(async () => ([
        { ...base, runId: 'run-third', status: 'running' as const, resumedFromRunId: 'run-second' },
        { ...base, runId: 'run-first' },
        { ...base, runId: 'run-second', resumedFromRunId: 'run-first' },
      ])),
    } as unknown as WorkflowService
    const bridge = new WorkflowBridge(service, { send: vi.fn() })

    await bridge.start()

    expect(bridge.getSessionRuns({ sessionId: 'session-1', cwd: '/repo' }).runs).toEqual([
      expect.objectContaining({ runId: 'run-third', resumedFromRunId: 'run-second' }),
    ])
  })

  it('publishes active-to-inactive lifecycle changes without requiring an inspector interest', async () => {
    let listener: ((event: StoredWorkflowEvent) => void) | null = null
    const service = {
      subscribe: vi.fn((next: (event: StoredWorkflowEvent) => void) => {
        listener = next
        return () => undefined
      }),
    } as unknown as WorkflowService
    const send = vi.fn()
    const bridge = new WorkflowBridge(service, { send })

    await bridge.start()
    bridge.registerRun('session-1', '/repo', {
      runId: 'run-lifecycle',
      status: 'running',
      workflow: { name: 'hunt', description: 'Find bugs' },
      cursor: 1,
      transcriptDirectory: '/state/run-lifecycle/transcripts',
    })
    send.mockClear()

    listener!({
      runId: 'run-lifecycle',
      cursor: 2,
      recordedAt: '2026-07-14T00:00:02.000Z',
      event: {
        schemaVersion: 1,
        type: 'run.completed',
        runId: 'run-lifecycle',
        sequence: 2,
        eventId: 'run-lifecycle:2',
        timestamp: '2026-07-14T00:00:02.000Z',
        payload: {
          result: { preview: 'done', lineCount: 1, content: 'done' },
        },
      },
    })

    expect(send).toHaveBeenCalledTimes(1)
    // Session-runs is addressed by SESSION: it describes one agent, so the
    // owning window is derived from the session rather than from whichever
    // renderer last registered a delivery interest.
    expect(send).toHaveBeenCalledWith({ sessionId: 'session-1' }, 'workflows:session-runs', {
      sessionId: 'session-1',
      cwd: '/repo',
      runs: [expect.objectContaining({
        runId: 'run-lifecycle',
        status: 'completed',
        cursor: 2,
      })],
    })
  })

  it('retains a lifecycle transition that arrives before startup inventory registration', async () => {
    let listener: ((event: StoredWorkflowEvent) => void) | null = null
    const staleReference = {
      runId: 'run-fast',
      cwd: '/repo',
      clientId: 'session-1',
      status: 'running' as const,
      cursor: 1,
      workflow: { name: 'fast', description: 'Finishes before registration' },
      transcriptDirectory: '/state/run-fast/transcripts',
    }
    let resolveInventory!: (references: Array<typeof staleReference>) => void
    const inventory = new Promise<Array<typeof staleReference>>(resolve => {
      resolveInventory = resolve
    })
    const service = {
      subscribe: vi.fn((next: (event: StoredWorkflowEvent) => void) => {
        listener = next
        return () => undefined
      }),
      listStoredRunReferences: vi.fn(() => inventory),
    } as unknown as WorkflowService
    const bridge = new WorkflowBridge(service, { send: vi.fn() })

    const started = bridge.start()
    // This ordering is the recorded service behavior: subscription is live while the bridge waits
    // for an inventory result that may already contain a stale manifest snapshot.
    listener!({
      runId: 'run-fast',
      cursor: 2,
      recordedAt: '2026-07-14T00:00:02.000Z',
      event: {
        schemaVersion: 1,
        type: 'run.completed',
        runId: 'run-fast',
        sequence: 2,
        eventId: 'run-fast:2',
        timestamp: '2026-07-14T00:00:02.000Z',
        payload: {
          result: { preview: 'done', lineCount: 1, content: 'done' },
        },
      },
    })
    resolveInventory([staleReference])
    await started

    expect(bridge.getSessionRuns({ sessionId: 'session-1', cwd: '/repo' }).runs).toEqual([
      expect.objectContaining({ runId: 'run-fast', status: 'completed', cursor: 2 }),
    ])
  })

  it('delivers one acknowledged cursor hint only for an interested run', async () => {
    vi.useFakeTimers()
    let listener: ((event: StoredWorkflowEvent) => void) | null = null
    const unsubscribe = vi.fn()
    const service = {
      subscribe: vi.fn((next: (event: StoredWorkflowEvent) => void) => {
        listener = next
        return unsubscribe
      }),
      status: vi.fn(async () => manifest('run-a', 0)),
      readEvents: vi.fn(async (
        _scope: unknown,
        { after }: { after: number },
      ) => ({
        runId: 'run-a',
        fromCursor: after,
        toCursor: 2,
        events: [stored('run-a', 2)],
        hasMore: false,
      })),
    } as unknown as WorkflowService
    const send = vi.fn()
    const bridge = new WorkflowBridge(service, { send, batchWindowMs: 16 })

    bridge.start()
    bridge.start()
    expect(service.subscribe).toHaveBeenCalledTimes(1)
    bridge.setRunInterest(7, { cwd: '/repo', runId: 'run-a', interested: true })
    await Promise.resolve()

    listener!(stored('run-a', 1))
    listener!(stored('run-b', 1))
    listener!(stored('run-a', 2))
    expect(send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(16)
    expect(send).toHaveBeenCalledTimes(1)
    // Event batches are addressed by RENDERER, because a batch answers the
    // delivery interest a specific renderer registered. With two windows open
    // on the same project both can hold interest in one run, each with its own
    // acknowledged cursor — a session-addressed send would leave one of them
    // permanently behind.
    expect(send).toHaveBeenCalledWith({ rendererId: 7 }, 'workflows:event-batch', {
      cwd: '/repo',
      runId: 'run-a',
      fromCursor: 1,
      toCursor: 2,
      events: [],
    })

    // A fast producer can advance forever while the renderer is slow; no second message is placed
    // in Chromium's IPC queue until the durable catch-up corresponding to the first is complete.
    listener!(stored('run-a', 3))
    vi.advanceTimersByTime(16)
    expect(send).toHaveBeenCalledTimes(1)
    await bridge.readEvents({ cwd: '/repo', runId: 'run-a', after: 1 }, 7)
    bridge.acknowledgeEvents(7, { cwd: '/repo', runId: 'run-a', cursor: 2 })
    vi.advanceTimersByTime(16)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith({ rendererId: 7 }, 'workflows:event-batch', {
      cwd: '/repo',
      runId: 'run-a',
      fromCursor: 3,
      toCursor: 3,
      events: [],
    })

    bridge.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('passes explicit renderer cwd scope to snapshot, cursor, cancel, and resume', async () => {
    const snapshot = {
      manifest: manifest('run-a', 7),
      state: { runId: 'run-a' },
      cursor: 7,
    } as unknown as WorkflowRunSnapshot
    const service = {
      subscribe: () => () => undefined,
      status: vi.fn(async () => snapshot.manifest),
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
      cursor: 0,
      manifest: snapshot.manifest,
      state: createWorkflowState('run-a'),
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
    expect(service.status).toHaveBeenCalledWith(scope, 'run-a')
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

  it('rejects one unprojectable legacy event instead of violating the IPC byte cap', async () => {
    const oversized = stored('run-a', 1)
    ;(oversized.event.payload as Record<string, unknown>).legacyBlob = 'x'.repeat(2_000)
    const service = {
      subscribe: () => () => undefined,
      readEvents: vi.fn(async () => ({
        runId: 'run-a',
        cwd: '/repo',
        fromCursor: 0,
        toCursor: 1,
        events: [oversized],
        hasMore: false,
      })),
    } as unknown as WorkflowService
    const bridge = new WorkflowBridge(service, {
      send: vi.fn(),
      maxBatchBytes: 512,
    })

    await expect(bridge.readEvents({ cwd: '/repo', runId: 'run-a', after: 0 }))
      .rejects.toThrow('renderer safety cap')
  })

  it('caps durable reads before the service materializes a renderer page', async () => {
    const service = {
      subscribe: () => () => undefined,
      readEvents: vi.fn(async () => ({
        runId: 'run-a',
        fromCursor: 0,
        toCursor: 0,
        events: [],
        hasMore: false,
      })),
    } as unknown as WorkflowService
    const bridge = new WorkflowBridge(service, { send: vi.fn() })

    await bridge.readEvents({ cwd: '/repo', runId: 'run-a', after: 0, limit: 500 })

    expect(service.readEvents).toHaveBeenCalledWith(
      { cwd: '/repo', clientId: 'agent-code-renderer' },
      { runId: 'run-a', after: 0, limit: 32 },
    )
  })

  it('rejects acknowledgements beyond the durable cursor proven to that renderer', async () => {
    vi.useFakeTimers()
    let listener: ((event: StoredWorkflowEvent) => void) | null = null
    const service = {
      subscribe: (next: (event: StoredWorkflowEvent) => void) => {
        listener = next
        return () => undefined
      },
      status: vi.fn(async () => manifest('run-a', 1)),
      readEvents: vi.fn(async () => ({
        runId: 'run-a',
        fromCursor: 0,
        toCursor: 1,
        events: [stored('run-a', 1)],
        hasMore: false,
      })),
    } as unknown as WorkflowService
    const send = vi.fn()
    const bridge = new WorkflowBridge(service, { send, batchWindowMs: 1 })
    bridge.start()
    bridge.setRunInterest(9, { cwd: '/repo', runId: 'run-a', interested: true })
    await bridge.getSnapshot({ cwd: '/repo', runId: 'run-a' }, 9)
    await Promise.resolve()
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledTimes(1)

    bridge.acknowledgeEvents(9, { cwd: '/repo', runId: 'run-a', cursor: 999 })
    listener!(stored('run-a', 2))
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledTimes(1)

    await bridge.readEvents({ cwd: '/repo', runId: 'run-a', after: 0 }, 9)
    bridge.acknowledgeEvents(9, { cwd: '/repo', runId: 'run-a', cursor: 1 })
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenLastCalledWith({ rendererId: 9 }, 'workflows:event-batch', {
      cwd: '/repo',
      runId: 'run-a',
      fromCursor: 2,
      toCursor: 2,
      events: [],
    })
    vi.useRealTimers()
  })
})
