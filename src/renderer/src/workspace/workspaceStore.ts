// Workspace store public surface.
//
// The `useWorkspace` hook and its composed sub-hooks live under
// ./hook/*. This file exists only so external callers can keep
// importing from '../workspace/workspaceStore' while the actual
// implementation moved; updating ~30 call sites to the new path
// isn't worth the churn.
//
// Prefer importing from './hook' directly in new code.

export { useWorkspace, type Workspace } from './hook'

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

export { foldSemanticEvent } from './semantic/foldEvent'
export {
  codexHistoryMarker,
  codexTurnIdFromRollout,
  mapCodexRolloutToFeedEntries,
} from './codex/rollout'
export {
  claudeHistoryMarker,
  extractEmbeddedClaudeProgressEntry,
} from './claude/history'

export { collectLeaves } from './tile-tree/treeOps'

export type {
  PickerItem,
  QueuedMessage,
  ReaderModeState,
  SessionRuntime,
  SlashPickerState,
  SpotlightState,
  TileTabsState,
} from './workspaceState'
