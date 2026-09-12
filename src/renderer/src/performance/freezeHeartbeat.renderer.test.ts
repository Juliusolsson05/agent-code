import { afterEach, describe, expect, it, vi } from 'vitest'
import { startRendererFreezeHeartbeat } from './freezeHeartbeat.js'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('renderer baseline lifecycle', () => {
  it('owns one timer/observer set and releases everything on teardown without scanning the DOM', () => {
    vi.useFakeTimers()
    const disconnect = vi.fn()
    const observe = vi.fn()
    class Observer {
      static supportedEntryTypes = ['longtask', 'event']
      disconnect = disconnect
      observe = observe
    }
    vi.stubGlobal('PerformanceObserver', Observer)
    const report = vi.fn()
    Object.defineProperty(window, 'api', { value: { reportRendererHeartbeat: report }, configurable: true })
    const scan = vi.spyOn(document, 'getElementsByTagName')
    const query = vi.spyOn(document, 'querySelectorAll')
    const dispose = startRendererFreezeHeartbeat()
    expect(startRendererFreezeHeartbeat()).toBe(dispose)
    vi.advanceTimersByTime(31000)
    expect(report).toHaveBeenCalledTimes(31)
    expect(observe).toHaveBeenCalledTimes(2)
    expect(scan).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    expect(report.mock.calls[0][0]).toMatchObject({ longTasksSupported: true, inputSupported: true })
    dispose()
    vi.advanceTimersByTime(3000)
    expect(report).toHaveBeenCalledTimes(31)
    expect(disconnect).toHaveBeenCalledTimes(2)
  })
})
