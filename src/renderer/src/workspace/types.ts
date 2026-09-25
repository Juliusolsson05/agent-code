import type { BuiltInMcpDomain, BuiltInMcpOverrides } from '@mcp/shared/types'
// Local binding for in-file uses (SessionMeta.kind, etc.). The
// `export type { SessionKind }` re-export below does not bind the name
// locally, so this import is also required.
import type {
  AgentProviderKind,
  AgentProviderRuntime,
  SessionKind,
} from '@shared/types/providerKind'

// Tile tree data model.
//
// Design constraints (captured during brainstorming with the user):
//   1. Tabs on top, binary-split tiles inside each tab (iTerm2/tmux style).
//   2. New TAB prompts the user for a cwd. New SPLIT inherits the cwd of
//      the pane you split from.
//   3. Auto-restore on launch: the workspace serializes to disk on every
//      mutation (debounced) and rehydrates on next launch.
//   4. Every session is keyed by a SessionId that main spawns — the
//      renderer never mints them itself.
//
// Tree invariants (enforced by assertInvariants in workspaceStore):
//   - Every leaf's sessionId appears in `sessions`.
//   - Splits always have exactly two children. Closing one side collapses
//     the split into the surviving sibling.
//   - `ratio` is clamped to [0.1, 0.9] so no pane can become invisibly small.
//   - `focusedSessionId` on each tab references a leaf that actually exists
//     in that tab's root. Detached sessions intentionally do NOT use this
//     field for focus; mode-specific surfaces carry their own selection.

export type SessionId = string
export type TabId = string

export type SplitDirection = 'vertical' | 'horizontal'

// `TileNode` — the recursive binary split tree — lived here until #992. It is
// now `LegacyTileNode` in legacyWorkspaceV2.ts, which is the only place that
// still needs to understand one (to read an old file). Nothing at runtime
// owns, renders or mutates a tree.

/**
 * A project: a title, and a stable position that gives its agents their index
 * letter (A1, B7).
 *
 * It is called `Tab` and lives in `WorkspaceState.tabs` for one reason only:
 * renaming the in-memory field touches ~200 call sites and is cleanup, not
 * behavior (stage 8 of the #992 plan). What matters is what it no longer has:
 *
 *   - `root` — the tile tree that OWNED the tab's visible sessions. Ownership
 *     is `SessionMeta.projectId` now: a session says which project it belongs
 *     to, instead of a project holding a structure its sessions hang off.
 *   - `focusedSessionId` — the tree's focus. The focused lane's occupant is
 *     the one focus truth (U3); a second, per-project focus is exactly the
 *     shape of #266/#267/#271.
 *
 * A project therefore owns NOTHING (U4). It exists while at least one session
 * names it and is removed when its last session closes.
 */
export type Tab = {
  id: TabId
  title: string
}

/**
 * A project, post unified-layout merge (#992, plan
 * docs/superpowers/plans/2026-09-17-unified-stage-layout.md).
 *
 * This is the ON-DISK spelling of a project (`workspace.json`'s `projects`).
 * It is structurally what `Tab` is in memory; the two names exist because the
 * file was renamed in #992 and the in-memory field was not (see `Tab`). The
 * migration (workspaceShape.ts) mints these from v2 tabs and keeps the old
 * TabId as `id` so lane bindings, row project bindings, and labels survive
 * the merge unchanged.
 */
export type ProjectRef = {
  /** Old TabId — deliberately reused; see the comment above. */
  id: TabId
  title: string
  /** Spawn cwd default. Absent => inherit from the spawning context. */
  cwd?: string
}

/**
 * Which kind of backend a session drives.
 *
 *   'claude'   — a Claude Code child process. The pane renders the
 *                full Agent Code UI (feed, composer, slash picker, …)
 *                driven by the JSONL transcript + headless terminal
 *                screen scrape.
 *   'terminal' — a plain shell child process. The pane renders an
 *                xterm.js instance that receives raw PTY bytes and
 *                forwards keystrokes back, underneath the SAME shared
 *                PaneHeader every agent kind uses (#865 terminal-session
 *                parity): title/name row, color flag, Status Mode fill,
 *                and TAIL apply exactly as for an agent pane. Only the
 *                body differs — a raw PTY view, not a provider transcript.
 *
 * Persisted in SessionMeta so a reload restores each pane to the
 * right component. Absent (= undefined) in pre-terminal workspace.json
 * blobs, treated as 'claude' at load time.
 *
 * Re-exported from the shared source of truth (@shared/types/providerKind)
 * rather than redeclared, so this renderer union can never drift from the
 * preload bridge / main manager spelling. The many renderer files that
 * `import type { SessionKind } from '@renderer/workspace/types'` keep
 * working unchanged.
 */
export type { SessionKind } from '@shared/types/providerKind'

export type AgentViewModeOverride = 'agent' | 'terminal'

export type SessionSpawnSelection = {
  kind: SessionKind
  providerRuntime?: AgentProviderRuntime
}

/**
 * The browser pocket attached to an agent session (spec §3,
 * docs/decomposition/lane-browser-pocket.md Stage 3).
 *
 * WHY on the SESSION and not the lane: lanes are index-keyed
 * (TiledDispatchLayout renders `key={laneIndex}`), spliced by every grid
 * mutation, and projected down to `{ selectedSessionId }` on persist, so a
 * lane field would slide to the wrong agent or vanish. Spotlight holds a
 * session too. SessionMeta already rides autosave, migration, adoption,
 * project merge and removal; only replaceSession's literal and undo's
 * carryDurableMeta need to learn this field. Do NOT copy the
 * `dispatchColorFlags` pattern (a Settings map keyed by session id): it is
 * never remapped or cleaned and orphans on every reload.
 */
export type BrowserPocketConfig = {
  /**
   * Minted once, never re-minted. Names the guest and its cookie partition.
   * Reload, provider switch, rewind and undo all MINT NEW SessionIds
   * (idRemap.ts), so anything keyed by SessionId would log the user out of
   * their dev app on every reload.
   */
  pocketId: string
  /** Last committed top-level URL (http/https). Restored lazily on first show. */
  url?: string
  /** 'open' = split beside the agent; 'collapsed' = the lane strip only. */
  view: 'open' | 'collapsed'
  /** The pocket's share of the split, 0.2–0.8. Absent = half. */
  split?: number
  /** Which cookie jar: the pocket's own (default, D1) or the project's. */
  profile: 'lane' | 'project'
  /** CSS viewport emulation; absent = fill the slot. */
  viewport?:
    | { mode: 'fill' }
    | { mode: 'preset'; preset: string; landscape?: boolean }
    | { mode: 'free'; width: number; height: number }
  /** prefers-color-scheme override; absent = follow the OS. */
  colorScheme?: 'light' | 'dark'
  /** Page zoom for this pocket only (the host re-asserts it; guests inherit the app's zoom otherwise). */
  zoom?: number
}

export type SessionMeta = {
  /** Opaque TLDR storage key. Keep it across reload/provider handoff, but mint
   * a new one for duplicates, unrelated resumes and rewinds: their old status
   * may describe work that is absent from the new conversation. */
  tldrIdentity?: string
  /** cwd the session was spawned with — needed to respawn on relaunch. */
  cwd: string
  /**
   * Durable glance label shown in agent headers and index/status surfaces.
   *
   * WHY this stays on SessionMeta instead of a view-specific preference:
   * titles describe the agent's purpose, so Grid, Dispatch, and Tiled Dispatch
   * must all observe the same value and workspace autosave must carry it across
   * restarts. Some creators also seed this field before the user edits it.
   */
  title?: string
  /**
   * Durable identity for this agent's spoken name — NOT the name itself.
   *
   * WHY the name is not stored here: workspace.json is per-window and is
   * rewritten wholesale on every autosave, so two windows would each hold their
   * own copy of a global allocation and would drift apart on the first
   * conflicting save. This field carries only the opaque key; the main-process
   * registry owns the identity→name relation for the whole application.
   *
   * WHY it exists at all rather than using sessionId directly: a provider
   * switch, reload, rewind or crash recovery replaces the local session ID
   * while the user is looking at the same pane. Reusing sessionId would rename
   * the agent mid-conversation. This value is minted once, by the reconciler,
   * and then carried across every replacement. Duplicating an agent creates a
   * new session with no identity, so the copy correctly gets its own name.
   */
  agentNameId?: string
  /**
   * Which backend runs in this pane. Defaults to 'claude' when
   * absent so pre-terminal workspace.json blobs keep working — the
   * tile tree is always there, but old entries never carried kind.
   */
  kind?: SessionKind
  /**
   * Alternate execution runtime for the provider. Absent means the provider's
   * structured/default runtime; `terminal` currently selects OpenCode's native
   * TUI while intentionally retaining provider kind `opencode` for setup,
   * skills, MCP, and lifecycle behavior.
   */
  providerRuntime?: AgentProviderRuntime
  /**
   * Per-session override for the agent pane surface.
   *
   * WHY this is only agent|terminal, not Hybrid:
   * Hybrid is a cooperative runtime policy: the pane rests on terminal view,
   * then rendered-only feature state (drafts, queued prompts, pickers,
   * conditions) temporarily wakes the React surface. Persisting Hybrid at the
   * session level would blur "user wants this pane's steady-state surface" with
   * "features may lease rendering while active." The durable per-session choice
   * is intentionally narrow: force rendered Agent, force native Terminal, or
   * leave this undefined and follow the global Agent View Mode setting.
   */
  agentViewModeOverride?: AgentViewModeOverride
  /**
   * Provider's own session UUID (distinct from Agent Code's durable local
   * SessionId ownership key). For Claude this is either confirmed by the
   * committed JSONL `sessionId` field, supplied by an explicit resume request,
   * or provisionally observed from the proxy's `x-claude-code-session-id`
   * header before the root JSONL file exists.
   *
   * WHY proxy-observed identity is allowed here:
   *
   * The proxy header proves Claude has assigned a session id, but it does not
   * prove the committed transcript is durable/reloadable. The optional source
   * tag below lets the renderer persist that provisional identity while still
   * keeping transcriptStatus disconnected until JSONL confirms durability.
   */
  providerSessionId?: string
  providerSessionIdSource?:
    | 'jsonl-entry'
    | 'proxy-header'
    | 'resume-request'
    | 'runtime-start'
    // The runtime watched the user switch sessions inside a native TUI it
    // follows (Pi /new, /resume, /fork) — a durable identity, stated apart
    // from 'jsonl-entry' so a later reader can tell a deliberate follow from
    // an id first captured from a transcript row.
    | 'provider-follow'
  /**
   * For tmux-backed terminals (P1): the registry-managed tmux
   * session name. Captured from the spawn IPC response and passed
   * back as `recoverTmuxName` on subsequent launches so the same
   * tmux session is re-attached instead of respawned. Without this,
   * persistence wouldn't work — the renderer would have no way to
   * tell main "this old session is the one I want."
   *
   * Undefined for direct-PTY terminals (when tmux isn't available)
   * and for agent sessions (P3 may extend this; not in P1).
   */
  tmuxName?: string
  /**
   * Set on an `extension-view` pane: the contributed view id (`<extensionId>.<view>`)
   * this leaf hosts. The durable handle that answers "which extension view does this
   * pane render", the extension analogue of `tmuxName` for a terminal. The render
   * seam reads it; rehydrate uses it to decide whether the owning extension is still
   * installed. Absent on every non-extension kind.
   */
  extensionViewId?: string
  /** Browser pocket (see BrowserPocketConfig). Agent kinds only; absent = none. */
  browserPocket?: BrowserPocketConfig
  /**
   * Set on a "Linked Agent" — an agent spawned via the Linked Agent
   * command with another agent as its parent. Two consequences:
   *
   *  1. Dispatch list: the linked agent renders indented directly
   *     under its parent's row (see buildDispatchGroups) instead of
   *     at the bottom of the tab group like an ordinary detached
   *     dispatch agent.
   *  2. Lifecycle: closing the parent session cascade-closes every
   *     session that names it here (see closeLinkedChildren in
   *     pane.ts). The link is the child's property — the parent
   *     holds no list — so the cascade is a scan of `sessions`.
   *
   * Absent for every ordinary agent. The id points at another
   * session in the same workspace; if that session is already gone
   * the field is simply inert (the child becomes a normal top-level
   * dispatch row). We deliberately do NOT chain — a linked agent
   * created off another linked agent points at the SAME top-level
   * parent, so the depth is always at most one.
   */
  linkedParentId?: SessionId
  /**
   * Set on an agent created by the Orchestration MCP server.
   *
   * WHY this is intentionally separate from `linkedParentId`:
   * linked agents are a user-facing manual affordance with existing Dispatch
   * indentation and cascade-close semantics. Orchestration agents are created
   * programmatically by an MCP tool and need their own lifecycle, grouping, and
   * future controls. Reusing `linkedParentId` would make the first
   * implementation look convenient while quietly coupling two different
   * product concepts; future "show orchestration run", "review worker diff",
   * or "stop this run" features would then inherit linked-agent behavior by
   * accident.
   */
  orchestrationParentId?: SessionId
  orchestrationRootId?: SessionId
  orchestrationRunId?: string
  orchestrationRole?: string
  /**
   * True when an orchestration child was spawned from a duplicated provider
   * transcript rather than a blank conversation.
   *
   * WHY this is persisted on the child instead of only returned from the
   * create call:
   * follow-up MCP prompts and Dispatch status views need to know whether the
   * child's provider history came from the parent. The clone itself is already
   * independent on disk; these ids are explanatory metadata for handoff
   * prompts and debugging, not authority to mutate the parent transcript.
   */
  inheritedParentContext?: boolean
  inheritedParentProviderSessionId?: string
  inheritedProviderSessionId?: string
  /**
   * Durable marker that the first orchestration handoff prompt has already
   * been delivered to this child.
   *
   * WHY this cannot live only in main's OrchestrationBridge:
   * the bridge's prompt-delivery map is intentionally short-lived coordination
   * state. Workspace sessions survive app restarts and metadata pruning; the
   * fact that the child already received its identity/handoff guard must
   * survive with the child, otherwise the next `send_prompt` after restart
   * would inject a second bootstrap block mid-conversation.
   */
  orchestrationBootstrapPromptDelivered?: boolean
  /** The effective capabilities of the last known provider process. UI reads
   * this snapshot until an actual restart/adoption confirms different tools;
   * changing Settings alone must never pretend a live model has new tools. */
  builtInMcpDomains?: BuiltInMcpDomain[]
  /** Durable per-domain choices. {} inherits every global preference; missing
   * maps belong to legacy snapshots and migrate via sessionMcpOverrides. */
  builtInMcpOverrides?: BuiltInMcpOverrides
  /** User MCP server ids (#1143) the last known provider process was launched
   * with, as reported by main. Observed, like `builtInMcpDomains`; the choices
   * behind it live in `builtInMcpOverrides` under `user:<id>` keys. */
  userMcpServerIds?: string[]
  /**
   * Project membership (#992). THE ownership fact: a session belongs to the
   * workspace because it names a live project. It replaces all three ways a
   * v2 session could be owned — "I am a leaf of tabs[i].root", a
   * `detachedSessions` record's `projectTabId`, and a `buried` record's
   * `sourceTabId` — with one field on the session itself.
   *
   * Optional in the TYPE only because `SessionMeta` also describes v2 rows on
   * disk, which predate it, and the transient row `spawn` writes a moment
   * before its caller files it. It is set on every session a reducer has
   * finished creating, carried across provider swaps and reloads, and a row
   * without a live one is dropped at the autosave and rehydrate boundaries —
   * metadata is never its own owner (sessionOwnership.ts).
   */
  projectId?: TabId
  /**
   * Position inside its project's index: ascending, ties broken by the
   * `sessions` map's insertion order. The ONLY ordering key, replacing v2's
   * two-part rule (tree leaves depth-first, then detached by `detachedAt`).
   *
   * Stamped with `Date.now()` when a session is filed, so new agents list
   * last; carried verbatim across a provider swap or reload so a row does not
   * jump when its backend is replaced. Migrated v2 tree leaves hold small
   * ordinals (0, 1, 2…), which is what keeps them ahead of every timestamped
   * row exactly as "leaves first" used to.
   */
  joinedAt?: number
  /**
   * Terminals only: when the user last USED this shell — typed or pasted into
   * it, or a command started/finished, or a `cd` — in epoch ms (#1178).
   * Persisted so Close Old Agents can age a shell across restarts; the only
   * writer is workspace/terminalLastUsed.ts, which explains why a reload never
   * moves it.
   */
  lastUsedAt?: number
}

// `BuriedPaneRecord`, `DetachedSessionSurface` and `DetachedSessionRecord` lived
// here until #992. They were the two non-tree OWNERS of a session: a record in
// `detachedSessions` ("live, but in no tile tree") and a record in `buried`
// ("live, hidden"). Both statements are simply true of any pool session that
// no lane shows, so they are no longer kinds of thing. The shapes survive as
// `Legacy*` types in legacyWorkspaceV2.ts for reading old files.

/**
 * One lane in a Tiled Dispatch layout. lanes[0] is always the full index
 * lane; lanes[1..] are compact mini-list + agent-view lanes.
 */
export type DispatchLane = {
  /**
   * Session shown in this lane. Undefined => empty lane (renders a
   * lane-local "select an agent" prompt). On re-entry/rehydrate a lane
   * whose session no longer exists is reset to undefined and STAYS empty:
   * nothing refills a lane but the user (#681).
   *
   * The SAME sessionId may legitimately appear in more than one lane — the
   * earlier one-session-per-lane restriction was dropped because greying out
   * an agent just because it's open elsewhere is a confusing UX. When a
   * session is duplicated across lanes, the views MIRROR: Claude/Codex agent
   * views mirror for free (every TileLeaf reads the same per-session runtime
   * from the store and writes input keyed by sessionId, so feed + composer
   * reflect in all of them). Terminals are the one exception — their xterm
   * attach is currently single-attacher, so a duplicated TERMINAL only fully
   * mirrors once terminal multi-attach (ref-counted attach + PTY broadcast)
   * lands in its own follow-up. Until then, a duplicated terminal's second
   * view may not stream; agents are unaffected.
   */
  selectedSessionId?: SessionId
}

/**
 * One row of Grid Dispatch: a COMPLETE dispatch view, not a strip of lanes.
 *
 * Each row owns its own index list, its own project binding, its own list
 * density, and its own height. That is what makes "add a row" mean "add another
 * whole dispatch surface" rather than "make everything shorter", and it is why
 * per-row project binding is expressible at all — a shared sidebar could not
 * answer "whose agents am I listing?" once two rows disagree.
 *
 * See docs/superpowers/plans/2026-08-30-grid-dispatch-mode.md for the design.
 */
export type DispatchGridRow = {
  /**
   * How many of `TiledDispatchState.lanes` belong to this row.
   *
   * INVARIANT: sum(rows[].length) === lanes.length. This is the one thing in
   * the grid that can desynchronize, which is why every mutation goes through
   * `gridShape.ts` (whose functions always return lanes and rows together) and
   * why `normalizeGridShape` repairs rather than trusts it on read.
   *
   * Row lengths are INDEPENDENT. There is deliberately no global column count
   * anywhere in this state: four lanes on top and two below is the expected
   * shape, not a degenerate one, because projects do not have equal agent
   * counts. Coupling row lengths would make New Lane in one row silently add a
   * lane to every other row.
   */
  length: number
  /** Relative height weight against sibling rows. Absent => equal share. */
  height?: number
  /** This row's index-list fraction of the row width. Absent => default. */
  indexFraction?: number
  /**
   * Restrict this row to these projects. Absent (or empty) => the row lists
   * every project. (Until #992 an unbound row followed a layout-wide
   * project/global scope; that scope is gone and unbound simply means all.)
   *
   * WHY a set rather than the single `projectTabId` this replaced: a row is a
   * working context, and a working context routinely spans two repos — an app
   * and the service it calls, a package and its consumer. One was simply the
   * wrong number.
   *
   * It stays cheap because `buildDispatchGroups` already groups dispatch rows
   * by tab, so a two-project row renders as two labelled sections in its index
   * with no new rendering code.
   *
   * INVARIANT: empty normalizes to absent. "Any project" must have exactly one
   * representation, or every reader needs to test for both.
   *
   * A binding FILTERS, it never fills: the user named a constraint, not an
   * occupant.
   */
  projectTabIds?: TabId[]
  /**
   * LEGACY single binding. `normalizeGridShape` folds a persisted one into
   * `projectTabIds` on read and nothing writes it again — the same read-time
   * migration the legacy `ratios` array gets. Kept on the type only so old
   * persisted state type-checks through that one normalization.
   */
  projectTabId?: TabId
  /**
   * Cap orchestration/linked children at ORCHESTRATION_CHILD_CAP in this row's
   * index and strips. Absent => capped (the default). One orchestration parent
   * can spawn ten children to review a PR, and ten depth-1 rows push every
   * other project off-screen for agents the user is not watching — the parent
   * is what reports.
   *
   * Purely presentational: this never reaches buildVisibleDispatchRows, so
   * labels, globalIndex, and cmd+N targeting are unaffected by toggling it.
   */
  capChildren?: boolean
  /** Parents the user expanded past the cap, in this row only. */
  expandedParents?: SessionId[]
}

export type TiledDispatchState = {
  /**
   * Every lane in the grid, FLAT and ROW-MAJOR. `rows` slices it.
   *
   * WHY flat rather than DispatchLane[][]: tiledDispatchSelectors' header
   * records that two whole bug classes came from code that maintained some lane
   * pointers and missed others, which is why remapTiledLanes /
   * clearTiledLaneSessions / keepTiledLaneSessions exist as the single reusable
   * way to keep lanes coherent, applied at nine call sites (id remap x2, kill,
   * close x2, bury, tab close, undo-close, rehydrate, autosave prune). A nested
   * array would rewrite all three helpers and every one of those sites. Flat
   * means there is still exactly ONE lane list to keep coherent, and none of
   * that code had to change to gain a second dimension.
   */
  lanes: DispatchLane[]
  /**
   * Lane index that currently owns keyboard selection (arrows / cmd+N).
   * Switching the focused lane must never change another lane's
   * selection — that's the whole point of per-lane independence.
   * Defaults to 0.
   *
   * Stays a FLAT scalar for the same reason `lanes` stays flat: it is read by
   * dispatchFocusedSessionId, dispatchTarget, agentIndexNavigation,
   * resolveDispatchSpawnTarget, useKeybinds, and applyDispatchSpawnFocus. Use
   * `rowIndexForLane` to recover its row rather than storing a second
   * coordinate — a per-row remembered column would be a SECOND source of focus
   * truth, which is the exact shape of #266/#267/#271/#272.
   */
  focusedLane: number
  /**
   * Row shape. Absent => [{ length: lanes.length }], i.e. the single-row
   * layout every workspace.json written before Grid Dispatch describes. That
   * default is why this change needs no migration for the common case.
   */
  rows?: DispatchGridRow[]
  /**
   * Row-major lane width weights, one per lane, normalized on read within each
   * row. Absent => even split. Replaces `ratios` (below); the two halves of
   * that array had to separate once each ROW gained its own index fraction.
   */
  laneWeights?: number[]
  /**
   * LEGACY. Index 0 was the single index sidebar's fraction of the whole row;
   * 1..N were the lane weights. `normalizeGridShape` splits a persisted one
   * into `rows[0].indexFraction` + `laneWeights` on read, and nothing writes
   * this field any more. Kept on the type only so old persisted state
   * type-checks through that one normalization.
   */
  ratios?: number[]
}

// `DispatchModeState` lived here until the unified layout (#992). It wrapped
// the lane grid in an optional MODE: `scope: 'project' | 'global'`, a classic
// single-selection `focusedSessionId`, and an optional `tiled` block whose
// presence chose between two layouts. All three are gone:
//   - the mode: the lane grid is the workspace, so it is a required field
//     (`WorkspaceState.stage`), never null and never "entered";
//   - the scope: every index lists every project, and a ROW's `projectTabIds`
//     binding is the only filter. The command that switched scope was deleted
//     with the mode, which would have stranded anyone whose saved scope was
//     'project' — another reason the field could not stay;
//   - the classic focus: `stage.focusedLane` is the one focus truth.
// Old files still carry the wrapper; workspaceShape.ts reads it once.

export type WorkspaceState = {
  tabs: Tab[]
  activeTabId: TabId
  // `gridRelatedSelections` lived here until #992: which related child a grid
  // pane was showing in place of its owner. See TileTree.tsx for why the stage
  // has no equivalent.
  /**
   * The stage: ragged rows of lanes. THE workspace — always present, never a
   * mode. A lane names a pool session or is empty; nothing fills a lane except
   * the user (#681) and the two continuity writes (entry seed on migration,
   * spawn into an empty focused lane).
   *
   * The type keeps its historical name (`TiledDispatchState`) and so do the
   * helpers in dispatch/gridShape.ts and dispatch/tiledDispatchSelectors.ts:
   * every shape rule and lane-coherence helper carries over byte for byte,
   * and renaming them is cleanup, not behavior.
   */
  stage: TiledDispatchState
  /**
   * The pool: every session the workspace owns, keyed by its durable id. Each
   * row names its project (`projectId`) and its place in that project's index
   * (`joinedAt`). This map is the ONLY home a session has (U1): the stage
   * merely points at some of it.
   *
   * `detachedSessions` and `buried` sat beside this until #992. They were
   * owner records for sessions outside the tile tree; with no tree there is
   * no "outside", and whether a session has a backend right now is a fact
   * about its RUNTIME (`processStatus`), not about which bucket lists it.
   */
  sessions: Record<SessionId, SessionMeta>
  /**
   * Ordered list of session IDs the user has explicitly pinned to the
   * top of the dispatch list. ORDER MATTERS — `pinnedSessionIds[0]`
   * renders at the top of the Pinned section. The modal commits via
   * setPinnedSessionIds, which preserves caller order (the Space-toggle
   * sequence in the modal).
   *
   * Pinned sessions are ALWAYS visible in the Pinned section
   * regardless of dispatch scope (project vs global) — the whole
   * point of pins is that they survive the scope toggle. To keep the
   * cross-project view readable, each pinned row in
   * DispatchAgentList renders a small project chip (tab letter +
   * project basename). See dispatchSelectors.buildPinnedDispatchRows.
   *
   * Sessions that disappear from `sessions` are dropped at render
   * (buildPinnedDispatchRows skips missing ids) and at save time
   * (useAutoSave filters against the pruned session map) so a killed
   * session can never linger in the Pinned section as a phantom row
   * or in workspace.json as a stale entry.
   *
   * Any session kind can be pinned, terminals included (#865).
   */
  pinnedSessionIds: SessionId[]
  /**
   * The most recent bulk provider switch, remembered so the user can send
   * that exact batch back to its origin provider from the Switch Agents modal
   * (e.g. "I parked 20 agents on Claude when Codex was rate-limited; bring them
   * back now that the limit reset"). Only ONE batch is kept — a newer bulk
   * switch replaces it, and returning the batch clears it. Null when there is
   * nothing to return.
   *
   * WHY this remains in-memory and deliberately NOT in PersistedWorkspace:
   * local SessionIds now survive restart, so identity is no longer the blocker.
   * This record is operational undo history, however, and persisting it would
   * promise that a provider switch remains reversible after arbitrary provider
   * history changes and app upgrades. We have no acceptance proof for that
   * stronger promise yet. Keep the one-run convenience semantics until a
   * dedicated durable provider-switch protocol owns validation and expiry.
   */
  lastProviderSwitchBatch?: ProviderSwitchBatch | null
}

/**
 * One agent's membership in a remembered bulk provider switch. Captured AFTER
 * the forward switch completes, because `replaceSession` mints a new SessionId
 * on every switch — `sessionId` here is the post-switch id, which is what
 * "return" must act on.
 */
export type ProviderSwitchBatchAgent = {
  sessionId: SessionId
  cwd: string
  /** Where the agent came from — the provider "return" sends it back to. */
  originalKind: AgentProviderKind
  /**
   * Where the agent is now (the forward switch's target). Return only acts on
   * agents whose CURRENT kind still equals this, so an agent the user has
   * since manually switched back (or closed) is skipped instead of being
   * yanked off whatever provider they intentionally moved it to.
   */
  switchedToKind: AgentProviderKind
  /** For the return summary / labels only. */
  title?: string
}

/** The single remembered bulk provider switch. See WorkspaceState.lastProviderSwitchBatch. */
export type ProviderSwitchBatch = {
  id: string
  switchedAt: number
  /** Batch-level direction, for the banner text ("Codex → Claude"). */
  sourceKind: AgentProviderKind
  targetKind: AgentProviderKind
  agents: ProviderSwitchBatchAgent[]
  /**
   * Whether the user agreed to compaction-on-arrival for THIS batch, captured
   * from the modal that asked.
   *
   * WHY the return path needs it rather than deciding for itself: arrival
   * compaction spends the destination provider's quota and locks every
   * affected composer for the arrival wait plus the compaction wait — minutes
   * per pane, with no cancel. The forward flow puts that behind an explicit
   * checkbox and a quota disclosure. The return flow had no modal at all and
   * hard-coded it on for any Claude destination, so a single "Return 20" click
   * spent Claude quota twenty times and locked twenty composers with nothing
   * asked and nothing disclosed. Returning is the mirror of the switch the
   * user consented to, so it reuses that consent instead of inventing new
   * consent on the user's behalf.
   */
  compactOnArrival: boolean
}

// RATIO_MIN / RATIO_MAX / RATIO_DEFAULT (tile-tree split ratios) lived here
// until #992 deleted the tree. Lane and row sizing clamps live in
// dispatch/gridShape.ts.

// -----------------------------------------------------------------------------
// Mode-surface layout states. These lived in workspaceState.ts until the #493
// layer split moved SessionRuntime (and everything the runtime object is made
// of) into session-runtime/state.ts. Spotlight / Reader are pure VIEW
// selections — they reference TabId/SessionId and nothing from the runtime —
// so they belong with the rest of the layout data model here, not in the
// ingest layer. TileTabsState lived here too until the unified layout (#992)
// deleted Tile Tabs: rows bound to different projects are the stage's way of
// showing several projects at once.
// -----------------------------------------------------------------------------

export type SpotlightState = {
  tabId: TabId
  focusedSessionId: SessionId
}

export type ReaderModeState = {
  tabId: TabId
  focusedSessionId: SessionId
}

