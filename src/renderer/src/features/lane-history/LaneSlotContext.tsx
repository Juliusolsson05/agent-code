import { createContext, useContext } from 'react'

// Which stage lane a pane is being drawn in, for chrome that belongs to the
// LANE rather than to the agent (today: the "↶ A2" Lane Back chip).
//
// WHY a context and not a prop: the pane header is rendered by three leaf kinds
// (TileLeaf, TerminalLeaf, AgentTerminalLeaf) behind renderWorkspaceLeaf, which
// Spotlight and Sidekick share with lanes. Threading a lane index through all
// of them would add a parameter every non-lane caller has to pass as
// "nothing", which is exactly the kind of default #856 removed from that
// function. A context is absent by construction outside a lane, so Spotlight
// and Sidekick headers get no chip without knowing the feature exists.
//
// WHY the value is a bare number: consumers subscribe to the store for the
// lane's contents themselves. Putting the Workspace object here would
// re-render every pane header on every workspace change (the GC churn class
// of bug), when the only thing the provider knows is a stable coordinate.
//
// TiledDispatchLayout ALWAYS wraps a lane's content in the provider, never
// conditionally: changing the element type above the agent view remounts it
// (terminal re-attach, feed reset), the same reason renderWorkspaceLeaf wraps
// every lane leaf in PocketedLeaf.
const LaneSlotContext = createContext<number | null>(null)

export const LaneSlotProvider = LaneSlotContext.Provider

/** The flat lane index of the enclosing stage lane, or null outside one. */
export function useLaneSlot(): number | null {
  return useContext(LaneSlotContext)
}
