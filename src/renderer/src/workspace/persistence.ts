import type {
  BuriedPaneRecord,
  SessionId,
  SessionMeta,
  TabId,
  TileNode,
} from '@renderer/workspace/types'
import type { TileTabsState } from '@renderer/workspace/workspaceState'

// ---------------------------------------------------------------------------
// Persisted state shape (serialized to ~/.config/cc-shell/workspace.json)
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
  sessions: Record<SessionId, SessionMeta>
  buried?: BuriedPaneRecord[]
  tileTabs?: TileTabsState | null
  /** Draft input text per session, keyed by sessionId. Persisted so
   *  in-progress prompts survive app crashes and restarts. Only
   *  non-empty drafts are saved to keep the file small. */
  drafts?: Record<SessionId, string>
}
