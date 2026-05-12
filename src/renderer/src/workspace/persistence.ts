import type {
  BuriedPaneRecord,
  DetachedSessionRecord,
  DispatchModeState,
  SessionId,
  SessionMeta,
  TabId,
  TileNode,
} from '@renderer/workspace/types'
import type { TileTabsState } from '@renderer/workspace/workspaceState'

// ---------------------------------------------------------------------------
// Persisted state shape (serialized to ~/.config/agent-code/workspace.json)
// ---------------------------------------------------------------------------

/**
 * Persisted workspace shape. Live runtime state is NOT here — we
 * respawn sessions on load and their state rebuilds naturally from
 * fresh IPC events.
 */
export type PersistedWorkspace = {
  // Tab tree with sessionIds that refer to the CURRENT launch's
  // sessions. On load we re-spawn and remap ids, so persisted ids are
  // just placeholders that get replaced.
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
   * These ids are pre-remap (current-launch ids at save time). On
   * load they pass through the same id remap as tile leaves /
   * detached / buried, and pins whose source session fails to
   * respawn are dropped — see buildRemappedPinnedSessionIds in
   * rehydrate.ts.
   */
  pinnedSessionIds?: SessionId[]
  tileTabs?: TileTabsState | null
  /** Draft input text per session, keyed by sessionId. Persisted so
   *  in-progress prompts survive app crashes and restarts. Only
   *  non-empty drafts are saved to keep the file small. */
  drafts?: Record<SessionId, string>
}
