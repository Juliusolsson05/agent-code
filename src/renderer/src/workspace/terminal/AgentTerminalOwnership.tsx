import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'

type RegisterMountedOwner = (sessionId: string) => () => void

type AgentTerminalOwnership = {
  mountedSessionIds: ReadonlySet<string>
  registerMountedOwner: RegisterMountedOwner
}

const AgentTerminalOwnershipContext = createContext<AgentTerminalOwnership | null>(null)

export function AgentTerminalOwnershipProvider({ children }: { children: ReactNode }) {
  const ownerCountsRef = useRef(new Map<string, number>())
  const [mountedSessionIds, setMountedSessionIds] = useState<ReadonlySet<string>>(() => new Set())

  const registerMountedOwner = useCallback<RegisterMountedOwner>(sessionId => {
    const ownerCounts = ownerCountsRef.current
    ownerCounts.set(sessionId, (ownerCounts.get(sessionId) ?? 0) + 1)
    setMountedSessionIds(new Set(ownerCounts.keys()))

    let released = false
    return () => {
      // WHY cleanup is idempotent and refcounted: Tile Tabs or tiled Dispatch
      // can legitimately render the same provider session more than once, and
      // React Strict Mode deliberately mounts effects twice in development.
      // A boolean would let one leaf's cleanup erase another live dimension
      // owner; an unguarded decrement would make Strict Mode invent negatives.
      if (released) return
      released = true
      const remaining = (ownerCounts.get(sessionId) ?? 1) - 1
      if (remaining > 0) ownerCounts.set(sessionId, remaining)
      else ownerCounts.delete(sessionId)
      setMountedSessionIds(new Set(ownerCounts.keys()))
    }
  }, [])

  const value = useMemo<AgentTerminalOwnership>(
    () => ({ mountedSessionIds, registerMountedOwner }),
    [mountedSessionIds, registerMountedOwner],
  )

  return (
    <AgentTerminalOwnershipContext.Provider value={value}>
      {children}
    </AgentTerminalOwnershipContext.Provider>
  )
}

export function MountedAgentTerminalOwner({
  sessionId,
  children,
}: {
  sessionId: string
  children: ReactNode
}) {
  const ownership = useAgentTerminalOwnership()

  useLayoutEffect(() => {
    // WHY this is a layout effect instead of an ordinary effect: when Reader
    // or Settings closes while the debug inline xterm is open, the pane xterm
    // is about to mount in the same commit. Publishing ownership before paint
    // lets DebugPanel remove the inline terminal before either terminal's
    // passive attach/resize effect can make two viewports fight over one PTY.
    return ownership.registerMountedOwner(sessionId)
  }, [ownership.registerMountedOwner, sessionId])

  return <>{children}</>
}

export function useHasMountedAgentTerminal(sessionId: string | null): boolean {
  const ownership = useAgentTerminalOwnership()
  return sessionId !== null && ownership.mountedSessionIds.has(sessionId)
}

function useAgentTerminalOwnership(): AgentTerminalOwnership {
  const ownership = useContext(AgentTerminalOwnershipContext)
  if (ownership === null) {
    // The registry is an application-level safety boundary. Failing loudly is
    // safer than silently enabling the inline terminal if a future renderer
    // moves either consumer outside App's provider.
    throw new Error('Agent terminal ownership requires AgentTerminalOwnershipProvider')
  }
  return ownership
}
