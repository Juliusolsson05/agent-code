type SessionDataEvent = {
  sessionId: string
  data: string
}

type SessionDataHandler = (data: string) => void
type SessionDataChannelSubscribe = (handler: (event: SessionDataEvent) => void) => () => void

export type SessionDataDispatcher = {
  subscribe(sessionId: string, handler: SessionDataHandler): () => void
  dispose(): void
}

/**
 * Route a renderer-global PTY channel to session-local consumers.
 *
 * WHY the underlying subscription deliberately survives an empty handler map:
 * terminal panes remount during tab/layout/surface changes. Removing and adding
 * the IPC listener across that gap adds unnecessary preload subscription churn.
 * This dispatcher does not buffer unowned data; host attach/backfill queues
 * remain responsible for replay across remounts. One inert listener is cheap; N listeners that
 * all inspect every Claude repaint are the performance bug fixed by #768.
 *
 * `dispose` exists for renderer teardown, HMR, and deterministic tests. Normal
 * host cleanup removes only its session closure and leaves the one channel
 * listener in place for the next mount.
 */
export function createSessionDataDispatcher(
  subscribeToChannel: SessionDataChannelSubscribe,
): SessionDataDispatcher {
  const handlersBySession = new Map<string, Set<SessionDataHandler>>()
  let stopChannel: (() => void) | null = null
  let disposed = false

  const ensureChannelSubscription = (): void => {
    if (stopChannel || disposed) return
    stopChannel = subscribeToChannel(event => {
      const handlers = handlersBySession.get(event.sessionId)
      if (!handlers) return

      // A callback may unmount a second consumer of the same session. Snapshot
      // the tiny owning set so delivery for the current PTY chunk is stable and
      // independent of React cleanup order.
      for (const handler of [...handlers]) handler(event.data)
    })
  }

  return {
    subscribe(sessionId, handler) {
      if (disposed) {
        throw new Error('Cannot subscribe to a disposed session data dispatcher')
      }

      let handlers = handlersBySession.get(sessionId)
      if (!handlers) {
        handlers = new Set()
        handlersBySession.set(sessionId, handlers)
      }
      // Subscription ownership is per registration, not callback identity.
      // Two hosts can intentionally reuse a callback; disposing one must not
      // remove the other host's registration from the shared channel.
      const registeredHandler: SessionDataHandler = data => handler(data)
      handlers.add(registeredHandler)
      try {
        ensureChannelSubscription()
      } catch (error) {
        // A failed preload setup has no cleanup callback to return to React.
        // Roll back now so a later successful mount cannot revive stale hosts.
        handlers.delete(registeredHandler)
        if (handlers.size === 0) handlersBySession.delete(sessionId)
        throw error
      }

      let active = true
      return () => {
        if (!active) return
        active = false
        const current = handlersBySession.get(sessionId)
        current?.delete(registeredHandler)
        if (current?.size === 0) handlersBySession.delete(sessionId)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      handlersBySession.clear()
      stopChannel?.()
      stopChannel = null
    },
  }
}

// Each Electron renderer window evaluates this module once, so these are
// per-window singletons without a main-process/global registry. Keeping shell
// and agent PTY channels separate preserves their existing attach contracts
// while enforcing the preload API's "subscribe once, dispatch by session id"
// invariant at the first renderer boundary.
let terminalDataDispatcher: SessionDataDispatcher | null = null
let agentPtyDataDispatcher: SessionDataDispatcher | null = null

function getTerminalDataDispatcher(): SessionDataDispatcher {
  terminalDataDispatcher ??= createSessionDataDispatcher(handler =>
    window.api.onSessionTerminalData(handler),
  )
  return terminalDataDispatcher
}

function getAgentPtyDataDispatcher(): SessionDataDispatcher {
  agentPtyDataDispatcher ??= createSessionDataDispatcher(handler =>
    window.api.onSessionAgentPtyData(handler),
  )
  return agentPtyDataDispatcher
}

export function subscribeToTerminalData(
  sessionId: string,
  handler: SessionDataHandler,
): () => void {
  return getTerminalDataDispatcher().subscribe(sessionId, handler)
}

export function subscribeToAgentPtyData(
  sessionId: string,
  handler: SessionDataHandler,
): () => void {
  return getAgentPtyDataDispatcher().subscribe(sessionId, handler)
}

// Vite can replace this module without reloading Electron's preload world.
// Explicit HMR disposal prevents a development edit from stacking stale IPC
// listeners and recreating the very fanout this module is meant to remove.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    terminalDataDispatcher?.dispose()
    terminalDataDispatcher = null
    agentPtyDataDispatcher?.dispose()
    agentPtyDataDispatcher = null
  })
}
