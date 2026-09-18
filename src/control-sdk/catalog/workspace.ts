import { z } from 'zod'

// Portable observation contracts; feature adapters translate their live state
// into these records. The SDK never imports or owns the workspace store.
// Placement kinds (#992). A session has exactly ONE ownership placement —
// 'project': it belongs to the project `tabId` — plus one view placement per
// place it is on screen: 'dispatch' (a lane, by index), 'reader', 'spotlight'.
//
// 'grid', 'related', 'detached' and 'buried' are v2's four ownership kinds
// (a tile-tree leaf, a related child shown in a parent's tile, a parked
// Dispatch row, a hidden pane). Nothing produces them any more; they stay in
// the enum for one release so a client that switches on them still parses,
// and leave with the rest of this schema's renames in stage 7 of the plan.
export const placementSchema = z.object({
  kind: z.enum(['project', 'dispatch', 'reader', 'spotlight', 'grid', 'related', 'detached', 'buried']),
  tabId: z.string().optional(), lane: z.number().optional(),
  gridOwnerSessionId: z.string().optional(), visible: z.boolean(),
})

export const workspaceObservationSchema = z.object({
  observedAt: z.number(), focusedSessionId: z.string().nullable(), ui: z.object({ commandPickerOpen: z.boolean(), settingsOpen: z.boolean(), inputOwnedBySurface: z.boolean() }), restoreStatus: z.string(), activeTabId: z.string(),
  // 'tiled-tabs' left this enum with the Tile Tabs feature (#992). The
  // remaining modes describe the stored layout shape until the stage is the
  // only shape (stage 3b of the unified layout); 'grid' and 'dispatch' then
  // go too.
  mode: z.enum(['grid', 'dispatch', 'tiled-dispatch']),
  // `focusedSessionId` was each tab's tile-tree focus. A project has no focus
  // of its own (#992): the one focus is the top-level `focusedSessionId`, the
  // focused lane's agent. Optional and never produced, for the same one-release
  // reason as the placement kinds above.
  tabs: z.array(z.object({ id: z.string(), title: z.string(), focusedSessionId: z.string().optional(), sessionIds: z.array(z.string()) })),
  sessions: z.array(z.object({
    sessionId: z.string(), title: z.string(), displayLabel: z.string().nullable().default(null).describe('Current window-local visible coordinate; can change with layout. Never use as a stable ID.'),
    displayedTitle: z.string().default('').describe('The current UI title, including prompt fallback where shown.'),
    agentName: z.string().nullable().default(null).describe('Stable spoken name for voice operation, e.g. "Apollo". Null when the Agent names setting is off or before a name has been allocated. Terminals are named too. Unlike displayLabel this does not change with layout, and it is never reused after an agent closes.'),
    cwd: z.string(), provider: z.string(),
    providerRuntime: z.string().nullable(), providerSessionId: z.string().nullable(),
    pinned: z.boolean(), placements: z.array(placementSchema),
  })),
})

