import { z } from 'zod'

// Portable observation contracts; feature adapters translate their live state
// into these records. The SDK never imports or owns the workspace store.
// Placement kinds (#992). A session has exactly ONE ownership placement —
// 'project': it belongs to the project `tabId` — plus one view placement per
// place it is on screen: 'dispatch' (a lane, by index), 'reader', 'spotlight'.
//
// The v2 ownership kinds ('grid', 'related', 'detached', 'buried') were held
// in this enum for one release after nothing produced them (#992 stage 3b);
// stage 7 removes them. An OLD client parsing NEW observations is unaffected
// (it simply never sees the removed values); a NEW client that still switches
// on them fails at compile time, which is the point of narrowing.
export const placementSchema = z.object({
  kind: z.enum(['project', 'dispatch', 'reader', 'spotlight']),
  tabId: z.string().optional(), lane: z.number().optional(),
  gridOwnerSessionId: z.string().optional(), visible: z.boolean(),
})

export const workspaceObservationSchema = z.object({
  observedAt: z.number(), focusedSessionId: z.string().nullable(), ui: z.object({ commandPickerOpen: z.boolean(), settingsOpen: z.boolean(), inputOwnedBySurface: z.boolean() }), restoreStatus: z.string(), activeTabId: z.string(),
  // The layout-mode field's whole vocabulary died with the two-mode layout
  // (#992): 'grid' and 'dispatch' described shapes that no longer save, and
  // 'tiled-tabs' went earlier. The FIELD stays as a literal for one release
  // so observations still parse for clients reading it; it is deprecated and
  // leaves with the next schema version — "which layout" is no longer a
  // question the app can ask.
  mode: z.literal('tiled-dispatch').describe('Deprecated: one layout since #992. Always \'tiled-dispatch\'.'),
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

