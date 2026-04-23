// Workspace store public surface.
//
// The `useWorkspace` hook and its composed sub-hooks live under
// ./hook/*. This file exists only so external callers can keep
// importing from '../workspace/workspaceStore' while the actual
// implementation moved; updating ~30 call sites to the new path
// isn't worth the churn.
//
// Prefer importing from './hook' directly in new code.

export { useWorkspace, type Workspace } from '@renderer/workspace/hook'

// -----------------------------------------------------------------------------
// Backward-compat re-exports.
//
// These symbols used to be declared inline in this file; extractions
// across the 2026-04-23 refactor split them into sibling modules.
// External consumers (ProxyDebugPanel, claudeSession, Feed.tsx,
// ghosts.ts, testing harness) continue to import from
// workspaceStore.ts via this re-export block. Prefer the new modules
// in new code — these re-exports exist to avoid churning the import
// graph.
// -----------------------------------------------------------------------------

export { foldSemanticEvent } from '@renderer/workspace/semantic/foldEvent'
export {
  codexHistoryMarker,
  codexTurnIdFromRollout,
  mapCodexRolloutToFeedEntries,
} from '@renderer/workspace/codex/rollout'
export {
  claudeHistoryMarker,
  extractEmbeddedClaudeProgressEntry,
} from '@renderer/workspace/claude/history'

export { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'

export type {
  PickerItem,
  QueuedMessage,
  ReaderModeState,
  SessionRuntime,
  SlashPickerState,
  SpotlightState,
  TileTabsState,
} from '@renderer/workspace/workspaceState'

// Re-exported from ./types so external callers (ReaderView, etc.)
// can keep importing from '../workspace/workspaceStore' without
// reaching into the internal types module. SessionId is a plain
// string alias but callers use the name for documentation.
export type { SessionId } from '@renderer/workspace/types'
