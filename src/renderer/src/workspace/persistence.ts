import type { LegacyWorkspaceV2Fields } from '@renderer/workspace/legacyWorkspaceV2'
import type {
  ProjectRef,
  SessionId,
  SessionMeta,
  TabId,
  TiledDispatchState,
} from '@renderer/workspace/types'

export type { LegacyDispatchMode } from '@renderer/workspace/legacyWorkspaceV2'

// ---------------------------------------------------------------------------
// Persisted state shape (serialized to ~/.config/agent-code/workspace.json)
// ---------------------------------------------------------------------------

/**
 * Persisted workspace shape. Live runtime state is NOT here: main reconciles
 * each session the stage shows with a backend, and runtime state rebuilds from
 * the returned level snapshot plus subsequent SessionFeed events.
 *
 * TWO GENERATIONS share this type, because one function reads both:
 *
 *   v3 (#992) — what this build WRITES. A fleet pool (`sessions`, each row
 *     carrying its `projectId` and `joinedAt`), the `projects` that group it,
 *     and the `stage` that places some of it on screen.
 *
 *   v2 — what older builds wrote: `tabs` owning tile trees, a
 *     `detachedSessions` bucket, a `buried` bucket, a `dispatchMode` envelope.
 *     Declared in legacyWorkspaceV2.ts and spread in here as all-optional
 *     fields. NEVER written by this build.
 *
 * WHY detect by shape instead of a version number: every v3 field has an
 * unambiguous meaning and every v2 field has an unambiguous translation, so a
 * read-time normalizer (`migrateWorkspaceToStage`) is total over both — and
 * over a file that carries BOTH, which the intermediate builds of #992 wrote.
 * A version integer would promise a downgrade path nobody has tested. This is
 * the same discipline `normalizeGridShape` uses for the legacy `ratios` array.
 *
 * DOWNGRADE: a build older than #992 opening a v3-only file finds no `tabs`,
 * throws in its rehydrate, and lands in its `persisted-fallback` path — a
 * fresh recovery tab with autosave LOCKED, so the v3 file is not overwritten.
 * The old build cannot show the workspace, but it cannot destroy it either.
 */
export type PersistedWorkspace = LegacyWorkspaceV2Fields & {
  /**
   * The pool. Keyed by durable Agent Code SessionIds — ownership keys, not
   * launch-scoped placeholders: a renderer reload adopts an existing backend
   * and a full restart cold-starts one under the same id. Provider history
   * identity is stored separately in SessionMeta.providerSessionId.
   *
   * In a v3 file every row has `projectId` naming a member of `projects`; a
   * row that does not is a ghost and is dropped on read (the v2 rule for a
   * detached record whose project was closed, restated for the pool).
   */
  sessions: Record<SessionId, SessionMeta>
  /** Projects: grouping only — an id, a title, a stable index letter. */
  projects?: ProjectRef[]
  /** Spawn defaults + index highlight; owns nothing. Former `activeTabId`. */
  activeProjectId?: TabId
  /** The workspace stage — ragged rows of lanes. Former `dispatchMode.tiled`. */
  stage?: TiledDispatchState
  /**
   * Ordered list of pinned session ids. Optional because legacy files predate
   * it; a failed backend recovery retains the pin because the session remains
   * retryable, and only a pin naming a session the pool dropped is removed.
   */
  pinnedSessionIds?: SessionId[]
  // `tileTabs` was persisted here until #992 deleted Tile Tabs. Old files
  // may still carry it; it is ignored on read and never written again.
  /** Draft input text per session. Persisted so in-progress prompts survive
   * crashes and restarts. Only non-empty drafts are saved. */
  drafts?: Record<SessionId, string>
}
