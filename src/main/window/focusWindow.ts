import type { BrowserWindow } from 'electron'

// Both automatic capability activation and an explicit operator handoff need
// the same acknowledgment. Calling focus() is only a request to the OS, so a
// successful tool must not authorize typing before Electron observes focus.
export async function focusWindow(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) throw new Error('Target window disappeared')
  if (window.isMinimized()) window.restore()
  window.show(); window.focus()
  if (window.isFocused()) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeListener('focus', focused) }
    const focused = () => { cleanup(); resolve() }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Window focus was not acknowledged')) }, 2500)
    window.once('focus', focused)
    if (window.isFocused()) focused()
  })
}
