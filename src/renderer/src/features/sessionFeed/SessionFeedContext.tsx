import { createContext, useContext, type ReactNode } from 'react'

import type { SessionFeed } from '@shared/sessionFeed/SessionFeed'

// React injection point for the SessionFeed contract.
//
// The desktop app mounts <SessionFeedProvider value={ipcSessionFeed}> once at
// the top of the tree (App.tsx); the remote mobile client mounts the same
// provider with its WebSocketSessionFeed; tests mount it with
// createFakeSessionFeed(). Everything below the provider is transport-blind.
//
// WHY a context and not a module-level singleton: a singleton would be
// decided at import time, which is exactly the coupling SessionFeed exists
// to remove — the remote client shares these component modules and must be
// able to pick a different transport for the same tree. Context makes the
// choice a mount-time decision.
const SessionFeedContext = createContext<SessionFeed | null>(null)

export function SessionFeedProvider({
  value,
  children,
}: {
  value: SessionFeed
  children: ReactNode
}): React.JSX.Element {
  return <SessionFeedContext.Provider value={value}>{children}</SessionFeedContext.Provider>
}

export function useSessionFeed(): SessionFeed {
  const feed = useContext(SessionFeedContext)
  if (feed === null) {
    // Fail loudly at first use rather than returning a dead stub: a missing
    // provider means session I/O would silently do nothing — prompts eaten,
    // events never arriving — which presents as a much harder bug than this.
    throw new Error(
      'useSessionFeed: no SessionFeedProvider above this component. ' +
        'Mount <SessionFeedProvider value={...}> at the root of the tree ' +
        '(desktop: ipcSessionFeed; remote client: WebSocketSessionFeed; ' +
        'tests: createFakeSessionFeed()).',
    )
  }
  return feed
}
