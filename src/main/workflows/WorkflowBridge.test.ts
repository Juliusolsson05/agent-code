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
// #1325 review B: alias writes can overlap, and the lost-edge order needs the
// first write's rename to finish last. A test sets `renameGate.hold` to make
// the next rename wait; every other rename is the real one.
const renameGate = vi.hoisted(() => ({ hold: null as Promise<void> | null }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      const hold = renameGate.hold
      renameGate.hold = null
      if (hold) await hold
      return actual.rename(from, to)
    },
  }
})

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

// #1280: a run is filed under the session id that started it (in memory and
// as its durable clientId). A replaced pane gets a new id, so its workflow
// cards vanished, and a restart rebuilt them under the dead id for good. On
// the owner's machine all 106 session-owned runs named a session that is no
// longer live.
describe('WorkflowBridge session carry (#1280)', () => {
  const { mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const { readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
  // The shape workflow-mcp's startResult() projects from a stored manifest:
  // every client-owned run in the owner's store has a lineageId and a script
  // path (#1325 review B), so the fixture carries both.
  const reference = (runId: string, clientId: string, extra: Record<string, unknown> = {}) => ({
    runId,
    cwd: '/repo',
    clientId,
    status: 'running' as const,
    cursor: 3,
    workflow: { name: 'hunt', description: 'Find bugs' },
    transcriptDirectory: `/state/${runId}/transcripts`,
    lineageId: runId,
    scriptPath: '/repo/.claude/workflows/hunt.js',
    ...extra,
  })
  const run = (runId: string, extra: Record<string, unknown> = {}) => {
    const { cwd: _cwd, clientId: _clientId, ...started } = reference(runId, 'unused', extra)
    return started
  }
  const runIds = (bridge: InstanceType<typeof WorkflowBridge>, sessionId: string, cwd = '/repo') =>
    bridge.getSessionRuns({ sessionId, cwd }).runs.map(entry => entry.runId)
  function aliasFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'workflow-aliases-'))
    return join(dir, 'workflow-session-aliases.json')
  }
  function service(references: unknown[]) {
    return {
      subscribe: () => () => undefined,
      listStoredRunReferences: vi.fn(async () => references),
      resume: vi.fn(async (_scope: unknown, input: { runId: string }) => ({ ...reference('run-resumed', 'x'), resumedFromRunId: input.runId })),
    } as unknown as WorkflowService
  }

  it('moves a pane\'s runs to its successor', async () => {
    const send = vi.fn()
    const bridge = new WorkflowBridge(service([reference('run-1', 'pane-old')]), { send, aliasFile: aliasFile() })
    await bridge.start()
    await bridge.carrySession('pane-old', 'pane-new')
    expect(bridge.getSessionRuns({ sessionId: 'pane-new', cwd: '/repo' }).runs.map(run => run.runId)).toEqual(['run-1'])
    expect(bridge.getSessionRuns({ sessionId: 'pane-old', cwd: '/repo' }).runs).toEqual([])
    expect(send).toHaveBeenCalledWith({ sessionId: 'pane-new' }, 'workflows:session-runs', expect.objectContaining({ runs: [expect.objectContaining({ runId: 'run-1' })] }))
  })

  it('finds the runs under the live id after a restart, through a chain of replacements', async () => {
    const file = aliasFile()
    const first = new WorkflowBridge(service([reference('run-1', 'pane-a')]), { send: vi.fn(), aliasFile: file })
    await first.start()
    await first.carrySession('pane-a', 'pane-b')
    await first.carrySession('pane-b', 'pane-c')
    // A restart: the durable clientId is still the id the run started under.
    const second = new WorkflowBridge(service([reference('run-1', 'pane-a')]), { send: vi.fn(), aliasFile: file })
    await second.start()
    expect(second.getSessionRuns({ sessionId: 'pane-c', cwd: '/repo' }).runs.map(run => run.runId)).toEqual(['run-1'])
    expect(second.getSessionRuns({ sessionId: 'pane-a', cwd: '/repo' }).runs).toEqual([])
    rmSync(file, { force: true })
  })

  it('files a resume after the carry under the successor', async () => {
    const svc = service([reference('run-1', 'pane-old')])
    const bridge = new WorkflowBridge(svc, { send: vi.fn(), aliasFile: aliasFile() })
    await bridge.start()
    await bridge.carrySession('pane-old', 'pane-new')
    await bridge.resume({ cwd: '/repo', runId: 'run-1' })
    expect(svc.resume).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'pane-new' }), expect.anything())
    expect(bridge.getSessionRuns({ sessionId: 'pane-new', cwd: '/repo' }).runs.map(run => run.runId)).toEqual(['run-resumed'])
  })

  it('tells a still-mounted view of the old pane that its runs left', async () => {
    const send = vi.fn()
    const bridge = new WorkflowBridge(service([reference('run-1', 'pane-old')]), { send, aliasFile: aliasFile() })
    await bridge.start()
    await bridge.carrySession('pane-old', 'pane-new')
    expect(send).toHaveBeenCalledWith({ sessionId: 'pane-old' }, 'workflows:session-runs', expect.objectContaining({ runs: [] }))
  })

  // Review A1: the pane's MCP tool call can return after the swap committed,
  // and registers under the id it captured. Its durable clientId is that id.
  it('files a run that registers after the carry under the successor, now and after a restart', async () => {
    const file = aliasFile()
    const bridge = new WorkflowBridge(service([]), { send: vi.fn(), aliasFile: file })
    await bridge.start()
    await bridge.carrySession('pane-old', 'pane-new')
    bridge.registerRun('pane-old', '/repo', run('run-late'))
    expect(runIds(bridge, 'pane-new')).toEqual(['run-late'])
    expect(runIds(bridge, 'pane-old')).toEqual([])
    const restarted = new WorkflowBridge(service([reference('run-late', 'pane-old')]), { send: vi.fn(), aliasFile: file })
    await restarted.start()
    expect(runIds(restarted, 'pane-new')).toEqual(['run-late'])
  })

  it('files a second late run under the successor after the first was carried', async () => {
    const bridge = new WorkflowBridge(service([reference('run-first', 'pane-old')]), { send: vi.fn(), aliasFile: aliasFile() })
    await bridge.start()
    await bridge.carrySession('pane-old', 'pane-new')
    bridge.registerRun('pane-old', '/repo', run('run-late'))
    expect(runIds(bridge, 'pane-new')).toEqual(['run-first', 'run-late'])
  })

  // Review A2: Resume finds the owner, then awaits the service; the carry
  // lands during that await.
  it('files a resume that returns after a carry under the successor', async () => {
    let finish!: (value: unknown) => void
    const svc = service([reference('run-parent', 'pane-old')])
    ;(svc.resume as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const bridge = new WorkflowBridge(svc, { send: vi.fn(), aliasFile: aliasFile() })
    await bridge.start()
    const resuming = bridge.resume({ cwd: '/repo', runId: 'run-parent' })
    await bridge.carrySession('pane-old', 'pane-new')
    finish(run('run-child', { resumedFromRunId: 'run-parent', lineageId: 'run-parent' }))
    await resuming
    expect(runIds(bridge, 'pane-new')).toEqual(['run-child'])
    expect(runIds(bridge, 'pane-old')).toEqual([])
  })

  // Review B: Reload Agents carries every pane without awaiting.
  it('keeps every edge on disk when two carries save at once', async () => {
    const file = aliasFile()
    const bridge = new WorkflowBridge(service([reference('run-a', 'a'), reference('run-x', 'x')]), { send: vi.fn(), aliasFile: file })
    await bridge.start()
    let release!: () => void
    renameGate.hold = new Promise(resolve => { release = resolve })
    const first = bridge.carrySession('a', 'b')
    // Let the first write reach its held rename before the second starts.
    await new Promise(resolve => setTimeout(resolve, 20))
    const second = bridge.carrySession('x', 'y')
    await new Promise(resolve => setTimeout(resolve, 20))
    release()
    await Promise.all([first, second])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 'b', x: 'y' })
  })

  it('keeps the runs the successor already has when the pane\'s runs join it', async () => {
    const bridge = new WorkflowBridge(service([reference('run-old', 'pane-old'), reference('run-new', 'pane-new')]), { send: vi.fn(), aliasFile: aliasFile() })
    await bridge.start()
    await bridge.carrySession('pane-old', 'pane-new')
    expect(runIds(bridge, 'pane-new')).toEqual(['run-old', 'run-new'])
  })

  // Review A5: a Resume filed under the successor before the carry landed.
  it('shows a moved run and its resume in the successor as one card, as a restart does', async () => {
    const bridge = new WorkflowBridge(service([
      reference('run-parent', 'pane-old'),
      reference('run-child', 'pane-new', { resumedFromRunId: 'run-parent', lineageId: 'run-parent' }),
    ]), { send: vi.fn(), aliasFile: aliasFile() })
    await bridge.start()
    await bridge.carrySession('pane-old', 'pane-new')
    expect(runIds(bridge, 'pane-new')).toEqual(['run-child'])
  })

  // Review A4: a slot holds one cwd, so the two cannot merge.
  it('never deletes a successor\'s runs in another working directory', async () => {
    const file = aliasFile()
    const bridge = new WorkflowBridge(service([
      reference('run-old', 'pane-old', { cwd: '/first' }),
      reference('run-new', 'pane-new', { cwd: '/second' }),
    ]), { send: vi.fn(), aliasFile: file })
    await bridge.start()
    await bridge.carrySession('pane-old', 'pane-new')
    expect(runIds(bridge, 'pane-new', '/second')).toEqual(['run-new'])
    expect(runIds(bridge, 'pane-old', '/first')).toEqual(['run-old'])
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('starts with the runs under the id they started with when the alias file is not JSON', async () => {
    const file = aliasFile()
    writeFileSync(file, '{"pane-a": "pane-b"')
    const bridge = new WorkflowBridge(service([reference('run-1', 'pane-a')]), { send: vi.fn(), aliasFile: file })
    await bridge.start()
    expect(runIds(bridge, 'pane-a')).toEqual(['run-1'])
  })

  it('stops at a cycle in the alias file instead of spinning', async () => {
    const file = aliasFile()
    writeFileSync(file, JSON.stringify({ 'pane-a': 'pane-b', 'pane-b': 'pane-a' }))
    const bridge = new WorkflowBridge(service([reference('run-1', 'pane-a')]), { send: vi.fn(), aliasFile: file })
    await bridge.start()
    expect(runIds(bridge, 'pane-a')).toEqual(['run-1'])
  })

  // Every replacement records an edge now, so a restart must drop the ones no
  // stored run needs or the file grows for the life of the install.
  it('drops edges no stored run reaches at start, and keeps the chains that do', async () => {
    const file = aliasFile()
    writeFileSync(file, JSON.stringify({ 'pane-a': 'pane-b', 'pane-b': 'pane-c', 'no-runs': 'gone' }))
    const bridge = new WorkflowBridge(service([reference('run-1', 'pane-a')]), { send: vi.fn(), aliasFile: file })
    await bridge.start()
    expect(runIds(bridge, 'pane-c')).toEqual(['run-1'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'pane-a': 'pane-b', 'pane-b': 'pane-c' })
  })

  it('forgets an old edge out of a pane that is live again', async () => {
    const file = aliasFile()
    const bridge = new WorkflowBridge(service([reference('run-1', 'pane-a')]), { send: vi.fn(), aliasFile: file })
    await bridge.start()
    await bridge.carrySession('pane-a', 'pane-b')
    await bridge.carrySession('pane-b', 'pane-a')
    expect(runIds(bridge, 'pane-a')).toEqual(['run-1'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'pane-b': 'pane-a' })
  })
})
