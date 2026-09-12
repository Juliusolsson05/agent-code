import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installApplicationShutdown, type ApplicationShutdownServices } from './applicationShutdown'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness() {
  const events = new EventEmitter()
  let veto = false
  const app = Object.assign(events, {
    quit: vi.fn(() => {
      events.emit('before-quit')
      if (!veto) events.emit('will-quit', { preventDefault: vi.fn() })
    }),
  })
  const sessionStop = vi.fn(async (): Promise<void> => undefined)
  const workflowStop = vi.fn(async (_reason: string): Promise<void> => undefined)
  const services = {
    getSessions: (): ReturnType<ApplicationShutdownServices['getSessions']> => ({ killAll: sessionStop }),
    getWorkflows: (): ReturnType<ApplicationShutdownServices['getWorkflows']> => ({ stop: workflowStop }),
    startupSettled: vi.fn(async (): Promise<void> => undefined),
    stopDictation: vi.fn(async (): Promise<void> => undefined),
    flushObservations: vi.fn(async (): Promise<void> => undefined),
    sweepOwnedProxies: vi.fn(async (): Promise<void> => undefined),
    stopBuiltInMcp: vi.fn(async (): Promise<void> => undefined),
    stopRemote: vi.fn(async (): Promise<void> => undefined),
    stopLsp: vi.fn(async (): Promise<void> => undefined),
    stopExternalControl: vi.fn(async (): Promise<void> => undefined),
    disposeControl: vi.fn(async (): Promise<void> => undefined),
    disposeWorkflowBridge: vi.fn(async (): Promise<void> => undefined),
    disposeCaffeinate: vi.fn(async (): Promise<void> => undefined),
    stopHeapWatchdog: vi.fn(async (): Promise<void> => undefined),
    drainWorkspace: vi.fn(async (): Promise<void> => undefined),
    drainDictationHistory: vi.fn(async (): Promise<void> => undefined),
    flushGhosts: vi.fn(async (): Promise<void> => undefined),
    flushRecordings: vi.fn(async (): Promise<void> => undefined),
    flushDictationDebug: vi.fn(async (): Promise<void> => undefined),
    flushPasteDebug: vi.fn(async (): Promise<void> => undefined),
    stopPerformance: vi.fn(async (): Promise<void> => undefined),
  } satisfies ApplicationShutdownServices
  const prepare = vi.fn()
  const onQuitAllowed = vi.fn()
  const onShutdownError = vi.fn()
  const onDiagnosticError = vi.fn()
  function install(platform: NodeJS.Platform = 'darwin') {
    return installApplicationShutdown({ app, services, prepare, onQuitAllowed, onShutdownError, onDiagnosticError, platform })
  }
  return { app, services, sessionStop, workflowStop, prepare, onQuitAllowed, onShutdownError,
    onDiagnosticError, install, setVeto: (value: boolean) => { veto = value } }
}

describe('application shutdown composition', () => {
  it('keeps every service and recorder usable after repeated editor vetoes', () => {
    const h = harness()
    const gate = h.install()
    h.setVeto(true)
    h.app.quit()
    h.app.quit()
    expect(h.prepare).toHaveBeenCalledTimes(2)
    expect(gate.isTerminalShutdownAdmitted()).toBe(false)
    expect(h.sessionStop).not.toHaveBeenCalled()
    expect(h.workflowStop).not.toHaveBeenCalled()
    for (const [name, service] of Object.entries(h.services)) {
      if (name.startsWith('get')) continue
      expect(service, name).not.toHaveBeenCalled()
    }
    expect(h.onQuitAllowed).not.toHaveBeenCalled()
  })

  it('starts both execution fences immediately and joins duplicate quit requests', async () => {
    const h = harness()
    const sessions = deferred()
    const workflows = deferred()
    h.sessionStop.mockImplementation(() => sessions.promise)
    h.workflowStop.mockImplementation(() => workflows.promise)
    const gate = h.install()
    h.app.quit()
    h.app.quit()
    expect(gate.isTerminalShutdownAdmitted()).toBe(true)
    expect(h.sessionStop).toHaveBeenCalledOnce()
    expect(h.workflowStop).toHaveBeenCalledOnce()
    expect(h.services.stopBuiltInMcp).not.toHaveBeenCalled()
    sessions.resolve()
    await sessions.promise
    expect(h.onQuitAllowed).not.toHaveBeenCalled()
    workflows.resolve()
    await vi.waitFor(() => expect(h.onQuitAllowed).toHaveBeenCalledOnce())
    expect(h.sessionStop).toHaveBeenCalledOnce()
    expect(h.workflowStop).toHaveBeenCalledOnce()
    expect(h.services.disposeControl.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.services.stopExternalControl.mock.invocationCallOrder[0]!,
    )
    expect(h.prepare).toHaveBeenCalledOnce()
  })

  it('retains inspection services after uncertain execution and retries only the failed owner', async () => {
    const h = harness()
    h.workflowStop.mockRejectedValueOnce(new Error('Native ownership unconfirmed'))
    const gate = h.install()
    h.app.quit()
    await vi.waitFor(() => expect(h.onShutdownError).toHaveBeenCalledOnce())
    expect(gate.isTerminalShutdownAdmitted()).toBe(true)
    expect(h.services.disposeWorkflowBridge).not.toHaveBeenCalled()
    expect(h.services.stopBuiltInMcp).not.toHaveBeenCalled()
    expect(h.services.stopExternalControl).not.toHaveBeenCalled()
    expect(h.onQuitAllowed).not.toHaveBeenCalled()
    h.app.quit()
    await vi.waitFor(() => expect(h.onQuitAllowed).toHaveBeenCalledOnce())
    expect(h.workflowStop).toHaveBeenCalledTimes(2)
    expect(h.sessionStop).toHaveBeenCalledOnce()
    expect(h.services.stopDictation).toHaveBeenCalledOnce()
  })

  it('retains completed support receipts when another support service rejects', async () => {
    const h = harness()
    h.services.stopRemote.mockRejectedValueOnce(new Error('remote stop failed'))
    h.install()
    h.app.quit()
    await vi.waitFor(() => expect(h.onShutdownError).toHaveBeenCalledOnce())
    expect(h.services.disposeControl).not.toHaveBeenCalled()
    h.app.quit()
    await vi.waitFor(() => expect(h.onQuitAllowed).toHaveBeenCalledOnce())
    expect(h.services.stopRemote).toHaveBeenCalledTimes(2)
    expect(h.services.stopLsp).toHaveBeenCalledOnce()
    expect(h.services.stopExternalControl).toHaveBeenCalledOnce()
    expect(h.sessionStop).toHaveBeenCalledOnce()
  })

  it('holds exit for required write settlement and retries a rejected drain without replaying stops', async () => {
    const h = harness()
    const writes = deferred()
    h.services.drainWorkspace.mockImplementationOnce(() => writes.promise)
    h.install()
    h.app.quit()
    await vi.waitFor(() => expect(h.services.drainWorkspace).toHaveBeenCalledOnce())
    expect(h.onQuitAllowed).not.toHaveBeenCalled()
    writes.reject(new Error('pending save failed'))
    await vi.waitFor(() => expect(h.onShutdownError).toHaveBeenCalledOnce())
    h.app.quit()
    await vi.waitFor(() => expect(h.onQuitAllowed).toHaveBeenCalledOnce())
    expect(h.services.drainWorkspace).toHaveBeenCalledTimes(2)
    expect(h.services.drainDictationHistory).toHaveBeenCalledOnce()
    expect(h.sessionStop).toHaveBeenCalledOnce()
  })

  it('waits for partial startup and drains an owner published by its admitted initializer', async () => {
    const h = harness()
    const startup = deferred()
    let workflowPublished = false
    h.services.getSessions = () => null
    h.services.getWorkflows = () => workflowPublished ? { stop: h.workflowStop } : null
    h.services.startupSettled.mockImplementation(() => startup.promise)
    h.install()
    h.app.quit()
    expect(h.workflowStop).not.toHaveBeenCalled()
    expect(h.services.stopBuiltInMcp).not.toHaveBeenCalled()
    workflowPublished = true
    startup.resolve()
    await vi.waitFor(() => expect(h.onQuitAllowed).toHaveBeenCalledOnce())
    expect(h.workflowStop).toHaveBeenCalledOnce()
    expect(h.sessionStop).not.toHaveBeenCalled()
  })

  it('closes an initializing workflow immediately, while startup settlement still gates support disposal', async () => {
    const h = harness()
    const startup = deferred()
    h.services.startupSettled.mockImplementation(() => startup.promise)
    h.workflowStop.mockImplementation(() => startup.promise)
    h.install()
    h.app.quit()
    expect(h.workflowStop).toHaveBeenCalledOnce()
    expect(h.services.stopBuiltInMcp).not.toHaveBeenCalled()
    startup.resolve()
    await vi.waitFor(() => expect(h.onQuitAllowed).toHaveBeenCalledOnce())
  })

  it('keeps macOS last-window closure live and sends other platforms through the same full composition', async () => {
    const mac = harness()
    mac.install('darwin')
    mac.app.emit('window-all-closed')
    expect(mac.app.quit).not.toHaveBeenCalled()
    expect(mac.services.stopLsp).not.toHaveBeenCalled()
    const linux = harness()
    linux.install('linux')
    linux.app.emit('window-all-closed')
    await vi.waitFor(() => expect(linux.onQuitAllowed).toHaveBeenCalledOnce())
    expect(linux.sessionStop).toHaveBeenCalledOnce()
    expect(linux.services.stopRemote).toHaveBeenCalledOnce()
  })

  it('reports diagnostic write failures after awaiting them without inventing native ownership uncertainty', async () => {
    const h = harness()
    const journal = deferred()
    h.services.flushGhosts.mockImplementation(() => journal.promise)
    h.install()
    h.app.quit()
    await vi.waitFor(() => expect(h.services.flushGhosts).toHaveBeenCalledOnce())
    expect(h.onQuitAllowed).not.toHaveBeenCalled()
    journal.reject(new Error('debug disk full'))
    await vi.waitFor(() => expect(h.onQuitAllowed).toHaveBeenCalledOnce())
    expect(h.onDiagnosticError).toHaveBeenCalledWith('ghosts', expect.any(Error))
    expect(h.onShutdownError).not.toHaveBeenCalled()
  })
})
