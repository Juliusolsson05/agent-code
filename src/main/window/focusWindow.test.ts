import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
const app = vi.hoisted(() => ({ focus: vi.fn() }))
vi.mock('electron', () => ({ app }))
import { focusWindow } from './focusWindow'
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })
function target() {
  let focused = false
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, isMinimized: () => true,
    isFocused: () => focused, restore: vi.fn(), show: vi.fn(), focus: vi.fn(() => { focused = true; window.emit('focus') }) })
  return window
}
it('requests application activation before the window and catches synchronous acknowledgment', async () => {
  const window = target()
  window.focus.mockImplementation(() => { expect(app.focus).toHaveBeenCalledWith({ steal: true }); window.isFocused = () => true; window.emit('focus') })
  await focusWindow(window as unknown as BrowserWindow)
  expect(window.restore).toHaveBeenCalledOnce()
  expect(window.listenerCount('focus')).toBe(0)
  expect(window.listenerCount('closed')).toBe(0)
})
it('does not claim focus on denied activation and cleans listeners on timeout/closure', async () => {
  vi.useFakeTimers()
  const window = target(); window.focus.mockImplementation(() => {})
  const denied = expect(focusWindow(window as unknown as BrowserWindow)).rejects.toThrow('did not acknowledge focus')
  await vi.advanceTimersByTimeAsync(2500); await denied
  expect(window.listenerCount('focus')).toBe(0)
  const closed = expect(focusWindow(window as unknown as BrowserWindow)).rejects.toThrow('disappeared')
  window.emit('closed'); await closed
  expect(vi.getTimerCount()).toBe(0)
})
