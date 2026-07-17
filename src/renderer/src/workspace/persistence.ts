import type {
  BuriedPaneRecord,
  DetachedSessionRecord,
  DispatchModeState,
  SessionId,
  SessionMeta,
  TabId,
  TileNode,
} from '@renderer/workspace/types'
import type { TileTabsState } from '@renderer/workspace/types'

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
  tileTabs?: TileTabsState | null
  /** Draft input text per session, keyed by sessionId. Persisted so
   *  in-progress prompts survive app crashes and restarts. Only
   *  non-empty drafts are saved to keep the file small. */
  drafts?: Record<SessionId, string>
}
