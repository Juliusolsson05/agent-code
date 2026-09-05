import { app, type BrowserWindow } from 'electron'

// App activation and window focus are different macOS operations. show/focus
// alone can leave our window behind the external operator (#797). Electron's
// documented app.focus({steal:true}) requests an explicit app handoff; it does
// not waive the subsequent window acknowledgment or guarantee OS permission.
// https://www.electronjs.org/docs/latest/api/app#appfocusoptions
export async function focusWindow(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) throw new Error('Target window disappeared')
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeListener('focus', focused); window.removeListener('closed', closed) }
    const focused = () => { if (!window.isDestroyed() && window.isFocused()) { cleanup(); resolve() } }
    const closed = () => { cleanup(); reject(new Error('Target window disappeared during activation')) }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Application activation was requested, but the target window did not acknowledge focus. Select this existing window through the OS Window menu, then inspect app.windows before continuing.'))
    }, 2500)
    // Subscribe before requests: show/restore/focus may emit synchronously.
    // A destroyed window must fail immediately rather than wait out the timer.
    window.on('focus', focused)
    window.once('closed', closed)
    try {
      if (window.isMinimized()) window.restore()
      app.focus({ steal: true })
      window.show()
      window.focus()
      focused()
    } catch (error) { cleanup(); reject(error) }
  })
}
