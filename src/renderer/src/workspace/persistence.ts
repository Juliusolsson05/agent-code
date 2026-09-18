import type {
  BuriedPaneRecord,
  DetachedSessionRecord,
  DispatchModeState,
  ProjectRef,
  SessionId,
  SessionMeta,
  TabId,
  TiledDispatchState,
  TileNode,
} from '@renderer/workspace/types'

// ---------------------------------------------------------------------------
// Persisted state shape (serialized to ~/.config/agent-code/workspace.json)
// ---------------------------------------------------------------------------

/**
 * Persisted workspace shape. Live runtime state is NOT here: main reconciles
 * each visible local SessionId with a backend, and runtime state rebuilds from
 * the returned level snapshot plus subsequent SessionFeed events.
 */
export type PersistedWorkspace = {
  // Tab tree keyed by durable Agent Code SessionIds. These are ownership keys,
  // not launch-scoped placeholders: renderer reload adopts an existing backend
  // and full app restart cold-starts one under the same id. Provider history
  // identity is stored separately in SessionMeta.providerSessionId.
  tabs: Array<{
    id: TabId
    title: string
    focusedSessionId: SessionId
    root: TileNode
  }>
  activeTabId: TabId
  dispatchMode?: DispatchModeState | null
  sessions: Record<SessionId, SessionMeta>
  detachedSessions?: Record<SessionId, DetachedSessionRecord>
  buried?: BuriedPaneRecord[]
  /**
   * Ordered list of pinned session ids. Optional because legacy
   * workspace.json files predate this field; rehydrate defaults the
   * runtime state to [] when this is absent or malformed.
   *
   * These ids use the same durable local ownership keys as tile leaves,
   * detached sessions, and buried panes. Failed backend recovery retains the
   * pin because the pane remains retryable; only truly unowned/corrupt rows are
   * removed during rehydrate.
   */
  pinnedSessionIds?: SessionId[]
  // `tileTabs` was persisted here until #992 deleted Tile Tabs. Old files
  // may still carry it; it is ignored on read and never written again.
  /** Draft input text per session, keyed by sessionId. Persisted so
   * in-progress prompts survive app crashes and restarts. Only
   * non-empty drafts are saved to keep the file small. */
  drafts?: Record<SessionId, string>
  // -------------------------------------------------------------------------
  // Unified-layout v3 fields (#992, plan 2026-09-17-unified-stage-layout.md).
  //
  // WHY these sit beside the v2 fields instead of replacing them: the merge
  // is staged so every stage ships green. Stage 1 ships the shape migration
  // (workspaceShape.ts) that PRODUCES this triple; the read/write paths flip
  // to it in stage 2; the v2 fields above are deleted in stage 3. Presence
  // of `stage` is the v3 discriminant (same detect-by-shape discipline as
  // normalizeGridShape — no schema-version bump for an unambiguous shape).
  // Until stage 2, autosave does NOT write these fields.
  // -------------------------------------------------------------------------
  /** Projects (former tabs, tree-less). Migration mints them from `tabs`. */
  projects?: ProjectRef[]
  /** Former `activeTabId`. Spawn defaults + index highlight; owns nothing. */
  activeProjectId?: TabId
  /** The workspace stage — ragged rows of lanes. Former `dispatchMode.tiled`. */
  stage?: TiledDispatchState
}
