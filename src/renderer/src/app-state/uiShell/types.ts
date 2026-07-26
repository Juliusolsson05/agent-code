import type { TabId, SessionId } from '@renderer/workspace/types'

export type DispatchAttachIntent = {
  sessionId: SessionId
  targetTabId: TabId
}

/**
 * A command waiting to be dispatched through the shared execution gateway.
 *
 * `source` mirrors the user-driven members of `CommandInvocationSource`.
 * Duplicated as a literal union rather than imported so this store slice does
 * not take a dependency on the command-execution layer, which imports the
 * catalog and would create a cycle through the store.
 */
export type PendingCommandInvocation = {
  id: string
  source: 'native-menu' | 'keybinding'
  /** Close the palette again once the command has run. True when the palette
   *  was not already open, so a menu click or chord does not leave it visible. */
  closeAfterRun: boolean
}

export type UiShellState = {
  commandPaletteOpen: boolean
  /**
   * A command id waiting to be dispatched, with the source that asked for it.
   *
   * WHY this channel exists: `dispatchCommand` needs a live `CommandContext`,
   * and building one is expensive — assembling the ~76 workspace actions and
   * flags is exactly the cost `CommandPalette` avoids paying while closed
   * (#494). The keybinding router is mounted in the workspace tree and cannot
   * cheaply build a context on every keydown.
   *
   * The native menu already solved this: main emits a bare id, and the palette
   * mounts its heavy implementation just long enough to resolve and run it. A
   * keypress is equally rare and equally intentional, so it pays the same
   * one-time cost by the same route. Generalizing the menu's private
   * `pendingMenuCommand` into a store field means keybinding and menu
   * invocations share ONE dispatch path rather than growing a second one.
   */
  pendingCommandInvocation: PendingCommandInvocation | null
  pathPickerOpen: boolean
  pathPickerDefault: string
  tileTabsModalOpen: boolean
  tileTabsInitialSelectedIds: TabId[]
  /** When true, the Reorder Tabs modal is open.
   *
   * WHY this lives in uiShell instead of WorkspaceState: the modal is
   * transient command chrome, not workspace data. The resulting tab
   * order is persisted through WorkspaceState only after the user
   * confirms. Keeping the draft UI state out of WorkspaceState prevents
   * autosave from recording half-finished reorder attempts that the
   * user later cancels with Escape. */
  reorderTabsOpen: boolean
  /** When true, the Pin Agents multi-select modal is open.
   *
   * Same rationale for living on uiShell as reorderTabsOpen above:
   * it's transient command chrome, not workspace data. The committed
   * pin list lands on WorkspaceState.pinnedSessionIds only after the
   * user confirms with Enter; keeping the draft selection out of the
   * persisted store prevents autosave from recording a half-edited
   * pin session that the user later cancels with Escape. */
  pinAgentsOpen: boolean
  settingsPageOpen: boolean
  buryPromptSessionId: SessionId | null
  debugBundleNotePrompt: {
    bundlePath: string
    sessionId: SessionId
    title: string
    description: string
  } | null
  // Non-null while the Attach-Recording-Note input modal is open (plan §7b).
  // The `reserved` marker is already written by the time this is set; noteId
  // is the handle the fill step updates.
  recordingNotePrompt: {
    sessionId: SessionId
    noteId: string
    title: string
  } | null
  viewPromptsSessionId: SessionId | null
  newAgentPlacementOpen: boolean
  /**
   * Non-null when the placement overlay is open in "attach detached
   * session to grid" mode. The overlay reads this to skip the kind
   * picker (the session already exists, we don't spawn a new one), which
   * detached sessionId to insert, and which tab owns the placement target.
   *
   * WHY a separate field instead of overloading newAgentPlacementOpen:
   * the two flows commit through different actions
   * (commitNewAgentPlacement spawns a new session;
   * attachDetachedToGrid moves an existing one), and conflating them
   * forces every overlay code path to disambiguate at the bottom of
   * the call stack instead of at the top.
   *
   * WHY the target tab is part of the intent:
   * Tiled Dispatch lane selection does not mutate activeTabId. Deferring tab
   * lookup until overlay render or reducer commit would make "attach the
   * focused lane's row" depend on whichever tab happened to be active before
   * the user entered global Tiled Dispatch. The visible row already carries
   * the correct tab id, so the command captures it once and every later step
   * treats it as the source of truth.
   */
  dispatchAttachIntent: DispatchAttachIntent | null
  /**
   * Non-null when the placement overlay is open in "Linked Agent"
   * mode. The value is the PARENT session id — the agent that was
   * focused when the Linked Agent command ran. The overlay reads
   * this to show only the Claude/Codex kind picker (no placement
   * step) and, on pick, calls `createLinkedAgent(kind, parentId)`.
   *
   * WHY a third overlay intent alongside newAgentPlacementOpen and
   * dispatchAttachIntent rather than overloading either: like
   * dispatchAttachIntent, the linked flow commits through its own
   * action and skips placement. Conflating it with the create flow
   * would force every overlay branch to disambiguate; a dedicated
   * field keeps each flow's intent legible at the top of the call
   * stack. See uiShell/slice.ts for the same reasoning on attach.
   */
  linkedAgentParentId: SessionId | null
  gitBarOpen: boolean
  worktreesBarOpen: boolean
  debugPanelOpen: boolean
  feedDebugPanelOpen: boolean
  /** When true, the right-hand Proxy Debug Panel is mounted. Shows
   *  the live SSE flow for the focused Claude session: flow
   *  attribution, per-turn/per-block state, text deltas, stop reason,
   *  usage. Opt-in view — only meaningful when the session was spawn
   *  with `useProxy` on, since the panel is driven by semantic events
   *  from the proxy adapter. */
  proxyDebugPanelOpen: boolean
  /** When true, the HTML Debug Panel is mounted. Captures `outerHTML`
   *  of the focused pane (located via the `data-pane-id` attribute on
   *  the TileLeaf root) so the user can copy the exact DOM React
   *  produced — useful for rendering debugging / pasting layouts into
   *  an LLM. Snapshot-based, not live; refresh button re-captures.
   *  Lives on the uiShell slice alongside the other three debug panels
   *  and follows the same toggle pattern. */
  htmlDebugPanelOpen: boolean
  /** Transient element-level renderer inspection mode. While enabled, clicks
   * inside the focused pane select DOM instead of activating it and open the
   * Rendering Debug inspector. This is intentionally not a persisted setting:
   * leaving click interception active after restart would make the app appear
   * broken, and the captured inputs may contain developer-sensitive payloads. */
  renderingDebugMode: boolean
  /** Workspace-wide feed auto-follow. While true, every *visible* agent pane
   *  tails, and a pane that becomes visible later (a new lane selection, a tab
   *  switch, a fresh split) is already tailing without the user re-running the
   *  command. This is a stance on the workspace, not a batch operation.
   *
   *  WHY a single flag OR-ed into per-session `tailMode` rather than bulk-writing
   *  every session's runtime flag: the OR needs no `setTailMode` primitive (only
   *  a toggle exists — workspace/hook/helpers.ts), no snapshot of what each
   *  session was before, and no policy for sessions created while it was on.
   *  Turning it off simply reveals the per-session flags that were there all
   *  along, so the two controls never have to be reconciled.
   *
   *  WHY there is no "which panes are visible" query behind this: there is no
   *  canonical visible-session selector in this codebase (`resolveTabSessions`
   *  answers membership, not visibility, and says so in its own header). The OR
   *  is resolved inside `TileLeaf`, which with one exception mounts only for
   *  on-screen panes — so grid tab-scoping, dispatch lanes, duplicate tiled
   *  lanes, and terminal exclusion all fall out of what React already mounts.
   *  The exception is Global Editor fullscreen, which keeps the workspace
   *  mounted under `display: 'none'`; the full reasoning for why that is
   *  tolerable lives at the OR site in TileLeaf.tsx. Reader Mode is a takeover
   *  and mounts no TileLeaf at all, so Tail All is inert there. See
   *  docs/superpowers/plans/2026-07-20-tail-all.md before replacing this with an
   *  enumeration; the enumeration has at least four documented ways to be wrong.
   *
   *  Deliberately NOT persisted, matching per-session `tailMode`: waking up to
   *  every feed pinned to the bottom with no visible cause is confusing. */
  tailAllMode: boolean
  /** When true, the .env-gated Dev Debug Panel is mounted. Unlike the
   *  stable debug panels above, this is a temporary module host for
   *  one-off investigations. Its modules are intentionally freeform:
   *  they may poll, render custom UI, or call IPC while a bug is being
   *  understood, and then disappear after the fix lands. */
  devDebugPanelOpen: boolean
  /** When true, the read-only Agent Status panel is mounted. This is
   *  intentionally uiShell state rather than WorkspaceState: the panel is
   *  command chrome over the current focused agent, not durable workspace
   *  data. It follows `commandTargetSessionId` the same way the debug panels
   *  do, so focus changes update what the inspector describes without
   *  persisting an extra "inspected session" source of truth. */
  agentStatusPanelOpen: boolean
  performancePanelOpen: boolean
  remotePanelOpen: boolean
  /** When true, the Global Editor overlay is mounted. Splits the
   *  workspace area: left half is a file tree + Monaco editor rooted
   *  at the focused agent's cwd, right half is the entire normal
   *  workspace UI (dispatch / tile / spotlight / etc), unchanged but
   *  resized.
   *
   *  WHY a separate flag rather than a "mode": the existing modes
   *  (dispatch, tile, spotlight, reader) are mutually exclusive
   *  surfaces. Global Editor is ORTHOGONAL — it wraps whatever
   *  surface is active without replacing it. Tracking it as a toggle
   *  flag keeps the mode-state machine untouched. */
  globalEditorOpen: boolean
  /** When true, the Search Conversation Prompts modal is open. Lives
   *  on the uiShell slice (not the workspace slice) because it's
   *  a cross-session concern: the modal reads prompts from ALL
   *  sessions on disk, not just those currently mounted. */
  promptSearchOpen: boolean
  /** When true, the Agent Activity modal is open. Lists every
   *  visible agent/terminal session grouped by tab with last-
   *  activity timestamps so the user can triage and close unused
   *  panes during a long session. Derived from existing transcript
   *  data — no separate tracking store. */
  agentActivityOpen: boolean
  /** When true, the Close Old Agents modal is open.
   *
   * WHY this is a separate modal flag instead of a mode inside Agent
   * Activity: the activity view is a manual inspector with row-level
   * actions, while Close Old Agents is a batch-destructive workflow with
   * threshold inputs, project scoping, and a computed preview. Keeping the
   * flags separate lets either surface evolve without inheriting the other
   * surface's keyboard model or confirmation semantics. */
  /** When true, the read-only Keyboard Shortcuts reference is open.
   *
   * WHY a separate flag rather than a tab inside the Settings modal: this is
   * consulted MID-TASK ("what was the chord for Reader Mode?") and closed two
   * seconds later. Routing it through Settings would put a mutable editor with
   * live key capture between the user and a one-line answer. */
  keyboardShortcutsOpen: boolean
  closeOldAgentsOpen: boolean
  /** When true, the Switch Agents (bulk provider switch) modal is open.
   *
   * WHY a separate flag rather than folding it into Close Old Agents: the two
   * share a two-pane scope/preview shape, but the verbs and safety models
   * differ — Close Old Agents is destructive and threshold-driven, while Switch
   * Agents is a reversible round-trip with a remembered-batch return affordance
   * living inside the same modal. Keeping the flags separate lets either modal
   * evolve without inheriting the other's confirmation semantics. */
  bulkProviderSwitchOpen: boolean
  /** When true, the Usage modal is open.
   *
   * WHY this is app chrome rather than provider/session state:
   * `/usage` intentionally compares multiple providers at once and reads each
   * provider's external auth source on demand. No single pane owns the modal,
   * and persisting it in WorkspaceState would make a quota inspection look
   * like durable workspace data. */
  usageModalOpen: boolean
  /** Non-null when the Rewind-to-Prompt modal is open. Value is the
   *  sessionId whose transcript the modal is showing prompts for.
   *  Selecting a prompt in the modal calls
   *  `workspace.rewindFocusedToPrompt(anchor)` and the modal closes.
   *  See `RewindToPromptModal` + the parent plan doc for the full
   *  contract. */
  rewindPromptSessionId: SessionId | null
  /**
   * Per-session agent view-mode picker modal. Was App.tsx-local useState
   * before #494 — moved into uiShell so the command palette and the
   * surface registry can drive it without App threading a callback. Same
   * open/close shape as rewindPromptSessionId: non-null = open for that
   * session.
   */
  agentViewModePickerSessionId: SessionId | null
  /** Session whose Dispatch color-flag picker modal is open, or null. */
  colorFlagPickerSessionId: SessionId | null
  /** Splitter ratio between the dispatch agent list and the active
   *  agent pane in `DispatchLayout`. 0..1, where 0.25 means the list
   *  is 25% of the available width. Clamped to [0.15, 0.5] when the
   *  setter is called so the user can't drag the list narrower than
   *  ~15% (rows would be unreadably truncated) or wider than half
   *  (the agent pane is what the user is actually working with;
   *  letting the list take more space defeats the purpose of
   *  dispatch).
   *
   *  WHY uiShell instead of workspace state: the ratio is transient
   *  UI chrome — like splitter positions in any editor, it belongs
   *  to "how the user has the window laid out right now," not to
   *  the saved workspace contents. In-memory only; lost on app
   *  reload, same policy as `globalEditor.splitterRatio` and the
   *  other panel-open flags here. If we ever want to persist it,
   *  this comment is the single load-bearing place that decision
   *  was made. */
  dispatchListRatio: number
  /** When true, the Tiled Dispatch tile-count prompt overlay is open.
   *  Transient command chrome (like newAgentPlacementOpen): the chosen
   *  count is applied immediately via workspace.enterTiledDispatch and the
   *  flag flips back to false — nothing about the prompt itself persists.
   *  A dedicated overlay (not a command-palette mode) keeps the numeric
   *  input out of the palette's large mode state machine. */
  tiledDispatchPromptOpen: boolean
}
