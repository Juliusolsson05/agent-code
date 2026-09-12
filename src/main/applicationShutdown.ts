import { installSessionShutdownGate, type SessionShutdownGate } from './sessionShutdownGate'

type Stop = () => void | Promise<void>
type QuitApp = Parameters<typeof installSessionShutdownGate>[0]['app'] & {
  on(event: 'before-quit', listener: () => void): unknown
}

export interface ApplicationShutdownServices {
  getSessions(): { killAll(): Promise<void> } | null
  getWorkflows(): { stop(reason: string): Promise<void> } | null
  /** Settles only after startup can no longer acquire another resource. */
  startupSettled(): Promise<void>
  stopDictation: Stop
  flushObservations: Stop
  sweepOwnedProxies: Stop
  stopBuiltInMcp: Stop
  stopRemote: Stop
  stopLsp: Stop
  stopExternalControl: Stop
  disposeControl: Stop
  disposeWorkflowBridge: Stop
  disposeCaffeinate: Stop
  stopHeapWatchdog: Stop
  drainWorkspace: Stop
  drainDictationHistory: Stop
  flushGhosts: Stop
  flushRecordings: Stop
  flushDictationDebug: Stop
  flushPasteDebug: Stop
  stopPerformance: Stop
}

interface Stage {
  promise: Promise<void>
  state: 'pending' | 'complete' | 'failed'
}

/**
 * The composition boundary matters more than the gate alone: a before-quit
 * listener elsewhere can dismantle services even when the gate correctly
 * honors the editor veto. Keep the complete disposal inventory here and wire
 * concrete owners in index.ts; tests exercise this same listener installer.
 *
 * These receipts describe what each existing service API established. They do
 * not upgrade a support-service dispose into observed native process exit, or
 * an admission-tail drain into fsync durability. Session/workflow custody stays
 * with their evidence-bearing lifecycle implementations.
 */
export function installApplicationShutdown(options: {
  app: QuitApp
  services: ApplicationShutdownServices
  prepare: () => void
  onQuitAllowed: () => void
  onShutdownError: (error: unknown) => void
  onDiagnosticError: (stage: string, error: unknown) => void
  platform?: NodeJS.Platform
}): SessionShutdownGate {
  const { services } = options
  const stages = new Map<string, Stage>()

  function run(name: string, action: Stop): Promise<void> {
    const prior = stages.get(name)
    if (prior) return prior.promise
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    const stage: Stage = { promise, state: 'pending' }
    stages.set(name, stage)
    // Attach rejection handling before action can fail, including while startup
    // is still being joined. A rejected receipt is retained for THIS attempt;
    // only a later explicit quit retries it. Successful stops are never replayed
    // because a different service failed afterward.
    void promise.then(() => { stage.state = 'complete' }, () => { stage.state = 'failed' })
    const fail = (error: unknown): void => reject(new Error(
      `Shutdown stage ${name}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    ))
    try { Promise.resolve(action()).then(resolve, fail) } catch (error) { fail(error) }
    return promise
  }

  function stopExecution(): Promise<void>[] {
    const sessions = services.getSessions()
    const workflows = services.getWorkflows()
    // Both APIs close mutation admission synchronously before their first await.
    // Do not serialize them: a stalled workflow stop cannot prevent cancellation
    // of interactive execution (or vice versa). Absent owners get no receipt:
    // startup may still be publishing the already-admitted initializer's owner.
    return [
      ...(sessions ? [run('sessions', () => sessions.killAll())] : []),
      ...(workflows ? [run('workflows', () => workflows.stop('Agent Code is quitting'))] : []),
    ]
  }

  async function join(promises: Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(promises)
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Application shutdown has unfinished stages')
  }

  async function drain(): Promise<void> {
    for (const [name, stage] of stages) if (stage.state === 'failed') stages.delete(name)
    const earlyStops = stopExecution()
    const dictationStop = run('dictation', services.stopDictation)
    // Startup checks the committed gate after asynchronous acquisition. Its
    // settlement closes the resource inventory; a missing SessionManager alone
    // is not evidence that workflow/MCP/other startup resources never existed.
    await services.startupSettled()
    await join([...earlyStops, ...stopExecution(), dictationStop])
    await run('observations', services.flushObservations)
    await run('proxy-sweep', services.sweepOwnedProxies)

    // Retain inspection/control infrastructure until native owners have drained.
    // In particular, a failed WorkflowService.stop must leave its bridge usable
    // for inspecting uncertainty instead of advertising a clean shutdown.
    await join([
      run('builtin-mcp', services.stopBuiltInMcp),
      run('remote', services.stopRemote),
      run('lsp', services.stopLsp),
      run('external-control', services.stopExternalControl),
    ])
    await join([
      run('control', services.disposeControl),
      run('workflow-bridge', services.disposeWorkflowBridge),
      run('caffeinate', services.disposeCaffeinate),
      run('heap-watchdog', services.stopHeapWatchdog),
    ])
    await join([
      run('workspace', services.drainWorkspace),
      run('dictation-history', services.drainDictationHistory),
    ])

    // Debug artifacts are not execution ownership or workspace save receipts.
    // Await their queued work, but report a diagnostic write failure without
    // misclassifying it as a provider that may still own a native conversation.
    await Promise.all(([
      ['ghosts', services.flushGhosts],
      ['recordings', services.flushRecordings],
      ['dictation-debug', services.flushDictationDebug],
      ['paste-debug', services.flushPasteDebug],
    ] satisfies Array<[string, Stop]>).map(async ([name, action]) => {
      try { await run(name, action) }
      catch (error) { options.onDiagnosticError(name, error) }
    }))
    await run('performance', services.stopPerformance)
  }

  // Preparation remains repeatable and reversible. Chromium may still veto
  // after this callback. No service stop, admission fence, or recorder finalize
  // belongs on this side of the editor decision.
  options.app.on('before-quit', () => {
    // Re-entering app.quit after the final drain must not enqueue fresh marks or
    // observations behind the persistence snapshot we are about to release.
    if (!gate.isTerminalShutdownAdmitted()) options.prepare()
  })
  const gate = installSessionShutdownGate({
    app: options.app,
    drain,
    onQuitAllowed: options.onQuitAllowed,
    onShutdownError: options.onShutdownError,
    ...(options.platform ? { platform: options.platform } : {}),
  })
  return gate
}
