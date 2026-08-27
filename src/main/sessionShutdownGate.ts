interface WillQuitEvent {
  preventDefault(): void
}

interface SessionShutdownApp {
  on(event: 'will-quit', listener: (event: WillQuitEvent) => void): unknown
  on(event: 'window-all-closed', listener: () => void): unknown
  quit(): void
}

interface SessionShutdownManager {
  killAll(): Promise<void>
}

interface SessionShutdownGateOptions {
  app: SessionShutdownApp
  getManager: () => SessionShutdownManager | null
  onQuitAllowed: () => void
  platform?: NodeJS.Platform
  onLastWindowClosed?: () => void
  onShutdownError?: (error: unknown) => void
}

export interface SessionShutdownGate {
  isTerminalShutdownAdmitted(): boolean
}

/**
 * Admit irreversible session teardown only after Electron has resolved every
 * renderer unload veto in favor of leaving the application.
 */
export function installSessionShutdownGate(
  options: SessionShutdownGateOptions,
): SessionShutdownGate {
  let shutdownPromise: Promise<void> | null = null
  let shutdownComplete = false
  let terminalShutdownAdmitted = false

  options.app.on('window-all-closed', () => {
    if ((options.platform ?? process.platform) === 'darwin') {
      // WHY macOS ignores the last-window event: closing windows hides the UI
      // while the app, agents, and app-owned MCP services remain live. Dock
      // activation must be able to recreate a window without restarting them.
      return
    }

    // WHY this event only requests quit: Electron emits window-all-closed
    // before will-quit. Calling killAll here would remove registry entries
    // synchronously, then the will-quit gate could observe an empty snapshot
    // and allow exit while the first call still awaited physical provider
    // stops. Keeping manager access out of this branch makes the gate below the
    // sole owner of the exact teardown promise on every platform.
    options.onLastWindowClosed?.()
    options.app.quit()
  })

  options.app.on('will-quit', event => {
    if (shutdownComplete) {
      // WHY final lifecycle bookkeeping lives on the re-entered event: process
      // lock release and clean-run journaling are truthful only once teardown
      // has settled and this quit is no longer being prevented.
      options.onQuitAllowed()
      return
    }

    const manager = options.getManager()
    if (!manager) {
      // WHY absence is already terminal: packaging smoke and failed startup can
      // legitimately quit before SessionManager construction. Inventing an
      // async gate there would hold Electron for work that cannot exist.
      terminalShutdownAdmitted = true
      shutdownComplete = true
      options.onQuitAllowed()
      return
    }

    // WHY this is will-quit rather than before-quit: Electron emits
    // before-quit before BrowserWindow's beforeunload/will-prevent-unload
    // decision. A user choosing Keep Editing never reaches will-quit, so this
    // boundary cannot strand a surviving app behind SessionManager's permanent
    // shutdown fence.
    event.preventDefault()
    if (shutdownPromise) return

    // WHY this is a one-way app-level fact rather than an alias for the current
    // promise: killAll makes SessionManager terminal before its first await. If
    // teardown later rejects, macOS still must not create a fresh renderer
    // whose unload veto could strand an unusable, partially stopped app. A
    // later explicit quit may retry teardown, but this process may never return
    // to ordinary window/session creation once admission crossed this line.
    terminalShutdownAdmitted = true

    // WHY duplicate will-quit events join one exact promise: killAll marks
    // recovery/replacement claims terminal before awaiting provider stops.
    // Starting a second teardown is unnecessary, while clearing that fence to
    // roll back a veto would be unsafe because some stops may already be done.
    shutdownPromise = manager
      .killAll()
      .then(() => {
        shutdownComplete = true
        options.app.quit()
      })
      .catch(error => {
        // WHY failure stays fail-closed but retryable: allowing Electron to exit
        // would abandon ownership teardown; retaining the rejected promise
        // would make every later explicit quit a silent no-op.
        shutdownPromise = null
        options.onShutdownError?.(error)
      })
  })

  return {
    isTerminalShutdownAdmitted: () => terminalShutdownAdmitted,
  }
}
