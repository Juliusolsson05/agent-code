import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'

type RegisterDimensionClaim = (sessionId: string) => () => void

type AgentTerminalOwnership = {
  claimedSessionIds: ReadonlySet<string>
  registerDimensionClaim: RegisterDimensionClaim
}

const AgentTerminalOwnershipContext = createContext<AgentTerminalOwnership | null>(null)

// Default-visible is intentional: most workspace renderers are physically
// removed when they lose the main surface, so they need no extra coordination.
// Only shells that retain a subtree under display:none must opt in and tell the
// terminal boundary that "mounted" no longer means "can measure a viewport."
const AgentTerminalOwnerVisibilityContext = createContext(true)
const AgentTerminalDimensionActiveContext = createContext(true)

export function AgentTerminalOwnerVisibilityProvider({
  visible,
  children,
}: {
  visible: boolean
  children: ReactNode
}) {
  return (
    <AgentTerminalOwnerVisibilityContext.Provider value={visible}>
      {children}
    </AgentTerminalOwnerVisibilityContext.Provider>
  )
}

export function AgentTerminalOwnershipProvider({ children }: { children: ReactNode }) {
  const ownerCountsRef = useRef(new Map<string, number>())
  const [claimedSessionIds, setClaimedSessionIds] = useState<ReadonlySet<string>>(() => new Set())

  const registerDimensionClaim = useCallback<RegisterDimensionClaim>(sessionId => {
    const ownerCounts = ownerCountsRef.current
    ownerCounts.set(sessionId, (ownerCounts.get(sessionId) ?? 0) + 1)
    setClaimedSessionIds(new Set(ownerCounts.keys()))

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
      setClaimedSessionIds(new Set(ownerCounts.keys()))
    }
  }, [])

  const value = useMemo<AgentTerminalOwnership>(
    () => ({ claimedSessionIds, registerDimensionClaim }),
    [claimedSessionIds, registerDimensionClaim],
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
  const ownerVisible = useContext(AgentTerminalOwnerVisibilityContext)
  const registered = ownerVisible && ownership.claimedSessionIds.has(sessionId)
  const [handoffComplete, setHandoffComplete] = useState(false)
  const dimensionActive = registered && handoffComplete

  useLayoutEffect(() => {
    // WHY visibility controls registration instead of component lifetime:
    // Global Editor fullscreen intentionally retains the complete workspace
    // under display:none so xterm/editor state survives the takeover. That
    // terminal is technically mounted but cannot measure positive dimensions,
    // so treating it as an owner would suppress the only usable debug terminal.
    if (!ownerVisible) return undefined

    // WHY this remains a layout effect: registration must be scheduled before
    // the browser can paint a newly visible pane. We do not depend on layout
    // effects to order passive terminal effects, however; React may flush a
    // child's passive setup before the provider state update below. The hidden
    // handshake in this component is the protection against that real ordering.
    return ownership.registerDimensionClaim(sessionId)
  }, [ownerVisible, ownership.registerDimensionClaim, sessionId])

  useEffect(() => {
    // WHY registration is not enough to reveal/enable the pane immediately:
    // the registry update removes DebugPanel's inline terminal in the same
    // render that makes `registered` true, but that terminal releases its PTY
    // listener in a passive cleanup. React may run this component's passive
    // setup before the sibling cleanup. Deferring the second state transition
    // until the current passive flush finishes makes the next render the first
    // one where pane writes and layout are enabled; by then the inline cleanup
    // from the registry render has completed.
    setHandoffComplete(registered)
  }, [registered])

  // WHY the pane is retained but layout-hidden until registration propagates:
  // returning null would destroy the xterm that Global Editor deliberately
  // preserves, while rendering it visibly in the registration commit permits
  // its passive fit effect to race an inline terminal whose cleanup has not run
  // yet. The first commit therefore has zero layout dimensions. The provider's
  // registry render first tells DebugPanel to remove the inline owner while the
  // pane remains hidden. The passive-flush handshake above then reveals the
  // pane in a later render, making the handoff safe without assuming any
  // particular sibling passive-effect order.
  return (
    <AgentTerminalDimensionActiveContext.Provider value={dimensionActive}>
      <div className={dimensionActive ? 'contents' : 'hidden'}>{children}</div>
    </AgentTerminalDimensionActiveContext.Provider>
  )
}

export function useAgentTerminalDimensionActive(): boolean {
  return useContext(AgentTerminalDimensionActiveContext)
}

export function useHasAgentTerminalDimensionClaim(sessionId: string | null): boolean {
  const ownership = useAgentTerminalOwnership()
  return sessionId !== null && ownership.claimedSessionIds.has(sessionId)
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
