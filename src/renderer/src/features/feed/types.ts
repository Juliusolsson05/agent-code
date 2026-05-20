import type { Entry } from '@shared/types/transcript'

/** Which agent provider this Feed is rendering for. Determines
 *  which row renderers are used for tool_use blocks. */
export type AgentProvider = 'claude' | 'codex'

/** Scroll info pushed from Feed to its parent on every scroll tick.
 *  Used by TileLeaf to render the scroll position indicator. */
export type ScrollInfo = {
  /** 0 = at bottom, 1 = at top. */
  fraction: number
}

// ---------------------------------------------------------------------------
// Debug row-visibility shapes
// ---------------------------------------------------------------------------
//
// Feed reports every visibility decision back to the feed-debug log
// so the panel can show "why didn't this entry render?" side by side
// with the timeline of RENDER-layer row additions. The `reason`
// enumeration names the check that gated the entry.

export type VisibleDecision = {
  key: string
  entry: Entry
  visible: boolean
  reason:
    | 'compact_boundary'
    | 'compact_summary'
    | 'conversation'
    | 'not_conversation'
    | 'meta_filtered'
}

export type DebugVisibleRow = {
  key: string
  slot: 'entry' | 'semantic' | 'work' | 'empty'
  label: string
  itemType?: string
  order?: {
    phase: 'empty' | 'content' | 'work' | 'queue'
    timeMs: number | null
    sequence: number
    source: string
  }
}

// ---------------------------------------------------------------------------
// Scroll-position memory
// ---------------------------------------------------------------------------
//
// When the user switches tabs, App.tsx unmounts the inactive tab's
// TileTree — and with it, every Feed inside. When they switch back,
// a fresh Feed mounts with a brand-new scroll container at scrollTop=0.
// Without intervention that snaps the viewport to the top (or to a
// weird "just after first paint" position), which the user rightly
// called out as "weird and stupid."
//
// The fix is to persist each Feed's scroll state OUTSIDE the React
// component tree so it survives unmount. See ./scroll.ts for the
// module-level Map.

export type ScrollPosition = {
  scrollTop: number
  stickyBottom: boolean
}
