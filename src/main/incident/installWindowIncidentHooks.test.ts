import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The hooks subscribe to Electron's `app` and `ipcMain` at install time. A
// plain EventEmitter stands in for both so the test drives the REAL listener
// the production code registers, rather than re-deriving its severity rule.
// The factory runs lazily (on the first import of 'electron'), by which point
// the static EventEmitter import above is resolved.
vi.mock('electron', () => ({ app: new EventEmitter(), ipcMain: new EventEmitter() }))
// Everything below is only reached by the freeze watchdog / window paths, which
// this suite never exercises. Stubbed so importing the module does not pull in
// the performance and window subsystems.
vi.mock('@main/performance/ElectronProcessSource.js', () => ({ readElectronDiagnostics: vi.fn() }))
vi.mock('@main/performance/MainProbe.js', () => ({ mainProbe: {} }))
vi.mock('@main/performance/MonitorCoordinator.js', () => ({ monitorCoordinator: { heartbeat: vi.fn() } }))
vi.mock('@main/window/windowRegistry.js', () => ({ getOutboundIpcDiagnostics: vi.fn() }))
vi.mock('@main/extensions/runtimeWindowMarker.js', () => ({ isCreatingExtensionRuntimeWindow: () => false }))

const electron = (await import('electron')) as unknown as { app: EventEmitter; ipcMain: EventEmitter }
const { installWindowIncidentHooks } = await import('./installWindowIncidentHooks.js')

type Incident = { kind: string; severity: string; reason?: string }

function install(): Incident[] {
  const incidents: Incident[] = []
  installWindowIncidentHooks({ recordIncident: (input: Incident) => incidents.push(input) } as never)
  return incidents
}

afterEach(() => {
  // Each install adds listeners and a watchdog interval; drop both so one
  // test's hooks never record into another's journal.
  electron.app.emit('will-quit')
  electron.app.removeAllListeners()
  electron.ipcMain.removeAllListeners()
})

function childGone(reason: string): void {
  electron.app.emit('child-process-gone', {}, {
    type: 'Utility', reason, exitCode: reason === 'killed' ? 15 : 1, name: 'Network Service',
  })
}

describe('installWindowIncidentHooks child-process-gone severity (#1135)', () => {
  it('journals a quit-time killed child as a warning, like the renderer handler does', () => {
    const incidents = install()
    // The exact pair from run 2026-09-20T08-34: the same teardown reported by
    // both handlers. They must agree, or a clean quit reads as an error.
    childGone('killed')
    electron.app.emit('render-process-gone', {}, {}, { reason: 'killed', exitCode: 15 })

    expect(incidents.map(i => [i.kind, i.severity])).toEqual([
      ['electron.child_process_gone', 'warn'],
      ['window.render_process_gone', 'warn'],
    ])
  })

  it('keeps real child failures, including an unknown reason, as errors', () => {
    const incidents = install()
    for (const reason of ['crashed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure', 'some-future-reason']) {
      childGone(reason)
    }
    expect(incidents.every(i => i.severity === 'error')).toBe(true)
    expect(incidents).toHaveLength(6)
  })

  it('still records a clean child exit, as a warning', () => {
    const incidents = install()
    childGone('clean-exit')
    expect(incidents).toEqual([expect.objectContaining({ kind: 'electron.child_process_gone', severity: 'warn' })])
  })
})
