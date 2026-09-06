import { z } from 'zod'

// Portable observation contracts; feature adapters translate their live state
// into these records. The SDK never imports or owns the workspace store.
export const placementSchema = z.object({
  kind: z.enum(['grid', 'related', 'dispatch', 'detached', 'buried', 'reader', 'spotlight']),
  tabId: z.string().optional(), lane: z.number().optional(),
  gridOwnerSessionId: z.string().optional(), visible: z.boolean(),
})

export const workspaceObservationSchema = z.object({
  observedAt: z.number(), focusedSessionId: z.string().nullable(), ui: z.object({ commandPickerOpen: z.boolean(), settingsOpen: z.boolean(), inputOwnedBySurface: z.boolean() }), restoreStatus: z.string(), activeTabId: z.string(),
  mode: z.enum(['grid', 'tiled-tabs', 'dispatch', 'tiled-dispatch']),
  tabs: z.array(z.object({ id: z.string(), title: z.string(), focusedSessionId: z.string(), sessionIds: z.array(z.string()) })),
  sessions: z.array(z.object({
    sessionId: z.string(), title: z.string(), displayLabel: z.string().nullable().default(null).describe('Current window-local visible coordinate; can change with layout. Never use as a stable ID.'),
    displayedTitle: z.string().default('').describe('The current UI title, including prompt fallback where shown.'), cwd: z.string(), provider: z.string(),
    providerRuntime: z.string().nullable(), providerSessionId: z.string().nullable(),
    pinned: z.boolean(), placements: z.array(placementSchema),
  })),
})

