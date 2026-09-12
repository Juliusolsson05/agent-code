import { EventEmitter } from 'node:events'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { installApplicationShutdown, type ApplicationShutdownServices } from '@main/applicationShutdown'
import { useGlobalEditorStore } from '../store'
import { useEditorBeforeUnloadGuard } from './useEditorBeforeUnloadGuard'

it('keeps the real editor veto ahead of all application service disposal', async () => {
  useGlobalEditorStore.setState({ byCwd: {}, cwdRecency: [], activeCwd: null })
  const hook = renderHook(useEditorBeforeUnloadGuard)
  const events = new EventEmitter()
  let windowsClosed = false
  const app = Object.assign(events, {
    quit: () => {
      events.emit('before-quit')
      if (!windowsClosed) {
        // Electron/Chromium is the external boundary: dispatch the actual
        // renderer hook, then emulate Keep Editing honoring its veto. This
        // catches a disposer in the real application listener composition,
        // which a test of SessionShutdownGate alone could never exercise.
        const unload = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(unload)
        if (unload.defaultPrevented) return
        windowsClosed = true
      }
      events.emit('will-quit', { preventDefault: vi.fn() })
    },
  })
  let executionStopped = false
  const stop = vi.fn(async () => { executionStopped = true })
  const supportStop = vi.fn(async () => undefined)
  const services: ApplicationShutdownServices = {
    getSessions: () => ({ killAll: stop }), getWorkflows: () => ({ stop }),
    startupSettled: async () => undefined,
    stopDictation: supportStop, flushObservations: supportStop, sweepOwnedProxies: supportStop,
    stopBuiltInMcp: supportStop, stopRemote: supportStop, stopLsp: supportStop,
    stopExternalControl: supportStop, disposeControl: supportStop,
    disposeWorkflowBridge: supportStop, disposeCaffeinate: supportStop, stopHeapWatchdog: supportStop,
    drainWorkspace: supportStop, drainDictationHistory: supportStop,
    flushGhosts: supportStop, flushRecordings: supportStop, flushDictationDebug: supportStop,
    flushPasteDebug: supportStop, stopPerformance: supportStop,
  }
  const onQuitAllowed = vi.fn()
  const gate = installApplicationShutdown({ app, services, prepare: vi.fn(), onQuitAllowed,
    onShutdownError: vi.fn(), onDiagnosticError: vi.fn() })
  try {
    act(() => {
      useGlobalEditorStore.getState().openFile({ cwd: '/repo', path: 'draft.ts', text: 'base', mtimeMs: 1, diskVersion: 'base' })
      useGlobalEditorStore.getState().updateFileText('/repo', 'draft.ts', 'unsaved revision')
    })
    app.quit()
    expect(windowsClosed).toBe(false)
    expect(executionStopped).toBe(false)
    expect(supportStop).not.toHaveBeenCalled()
    expect(gate.isTerminalShutdownAdmitted()).toBe(false)
    expect(useGlobalEditorStore.getState().byCwd['/repo']!.openFiles['draft.ts']!.currentText).toBe('unsaved revision')

    // Further editing remains possible after veto. Returning to the saved
    // baseline makes the later unload clean; no cached approval is fabricated.
    act(() => { useGlobalEditorStore.getState().updateFileText('/repo', 'draft.ts', 'base') })
    app.quit()
    await waitFor(() => expect(onQuitAllowed).toHaveBeenCalledOnce())
    expect(executionStopped).toBe(true)
    expect(gate.isTerminalShutdownAdmitted()).toBe(true)
  } finally {
    hook.unmount()
    useGlobalEditorStore.setState({ byCwd: {}, cwdRecency: [], activeCwd: null })
  }
})
