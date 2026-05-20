import type { Workspace } from '@renderer/workspace/workspaceStore'

export type CommandState = {
  label: string
  tone?: 'neutral' | 'accent' | 'danger'
}

/**
 * Which workspace surface a command belongs to.
 *
 * WHY this exists: the command registry used to be one flat list where
 * every command decided its own availability through ad-hoc `when`
 * guards (or didn't guard at all). That worked while Agent Code was
 * essentially a pane grid, but it broke down once Dispatch Mode became
 * a first-class layout. Grid-spatial commands — `Split Pane Right`,
 * `New Terminal Below`, `Focus Pane Left` — kept showing in the palette
 * while Dispatch was active, where "right"/"below"/"left" point at a
 * grid the user can't see. Worse, `Focus Pane *` and the layout
 * commands (`Normalize Layout`, `Rotate Layout`) were *silent no-ops*
 * in Dispatch: they mutate `tab.root` grid focus, which Dispatch does
 * not use. See issue #228.
 *
 * `surface` makes that classification explicit and machine-readable so
 * the palette can hide commands that don't apply to the current mode,
 * and so a future native menu (#148) can build itself from the same
 * model instead of re-deriving intent from title text.
 *
 *  - `app`      — always meaningful, mode-independent. New Tab,
 *                 Settings, Resume Session, Dispatch Mode toggle.
 *  - `grid`     — operates on the tile grid; hidden while Dispatch
 *                 Mode is active. Pane splits, directional pane
 *                 focus, layout normalize/rotate.
 *  - `dispatch` — only meaningful inside Dispatch Mode; hidden in the
 *                 grid. Pin/unpin agents, attach detached session,
 *                 Global Dispatch scope.
 *  - `session`  — acts on the current command-target session and
 *                 works in BOTH modes (the target resolver is already
 *                 Dispatch-aware — see commandTargetSessionId). Reload
 *                 Agent, Tail, Copy Last Response, Reader Mode.
 *  - `editor`   — Global Editor overlay. Orthogonal to grid/Dispatch
 *                 (the overlay wraps either), so NOT mode-gated; the
 *                 surface is a category, and editor commands keep
 *                 their own `when` for overlay-open checks.
 *  - `debug`    — developer/diagnostic tooling. Mode-independent;
 *                 grouped separately so it can be demoted or hidden.
 */
export type CommandSurface = 'app' | 'grid' | 'dispatch' | 'session' | 'editor' | 'debug'

export type CommandContext = {
  workspace: Workspace
  ui: {
    openNewTabPicker: () => void
    openResumePicker: (defaultCwd: string) => void
    openTileTabs: () => void
    openReorderTabs: () => void
    openSettings: () => void
    openViewPrompts: (sessionId: string) => void
    openPromptSearch: () => void
    openAgentActivity: () => void
    openRewindPrompt: (sessionId: string) => void
    toggleGitBar: () => void
    toggleWorktreesBar: () => void
    toggleDebugPanel: () => void
    toggleFeedDebugPanel: () => void
    toggleProxyDebugPanel: () => void
    toggleHtmlDebugPanel: () => void
    toggleDevDebugPanel: () => void
    openAgentStatusPanel: () => void
    closeAgentStatusPanel: () => void
    toggleAgentStatusPanel: () => void
    togglePerformancePanel: () => void
    toggleCaffeinate: () => Promise<void> | void
    toggleGlobalEditor: () => void
    /** Toggle visibility of the Global Editor's in-editor file tree.
     *  Only meaningful when the overlay is open — the command's
     *  `when` guard enforces that. The flag lives on the
     *  global-editor store (not uiShell) because it's editor-scoped
     *  state, not workspace chrome. */
    toggleFileTreeVisible: () => void
    enterDispatchMode: () => Promise<void> | void
    enterGlobalDispatch: () => Promise<void> | void
    exitDispatchMode: () => void
    /** Open the placement overlay in "attach detached session to grid"
     *  mode for the given sessionId. The session must exist in
     *  workspace.state.detachedSessions; the command's `when` guard is
     *  responsible for that check. */
    openDispatchAttach: (sessionId: string) => void
    /** Open the shared placement overlay in "Linked Agent" mode. The
     *  session id is the parent agent; the overlay only asks for
     *  Claude/Codex and then delegates to workspace.createLinkedAgent. */
    openLinkedAgent: (sessionId: string) => void
    /** Open the Pin Agents multi-select modal. Lives on uiShell as a
     *  transient flag — the draft selection state is owned by the
     *  modal itself, not the store. */
    openPinAgents: () => void
    toggleCustomRendering: () => void
    toggleStatusMode: () => void
    toggleWorktreeBadges: () => void
    setDangerousAgentsEnabled: (enabled: boolean) => void
    setAggressiveDebugPersistence: (enabled: boolean) => void
    enterResumeMode: () => void
    enterBuriedMode: () => void
    enterKillBuriedMode: () => void
    enterPromptTemplateMode: () => void
    enterSavePromptTemplateMode: () => void
    enterAiWorkspaceOpenMode: () => void
    enterAiWorkspaceCreateMode: () => void
    enterAiWorkspaceClearMode: () => void
    closePalette: () => void
  }
  flags: {
    customRenderingEnabled: boolean
    statusModeEnabled: boolean
    worktreeBadgesEnabled: boolean
    dangerousAgentsEnabled: boolean
    aggressiveDebugPersistenceEnabled: boolean
    gitBarOpen: boolean
    worktreesBarOpen: boolean
    debugPanelOpen: boolean
    feedDebugPanelOpen: boolean
    proxyDebugPanelOpen: boolean
    htmlDebugPanelOpen: boolean
    devDebugEnabled: boolean
    devDebugPanelOpen: boolean
    agentStatusPanelOpen: boolean
    performancePanelOpen: boolean
    caffeinateActive: boolean
    caffeinateSupported: boolean
    globalEditorOpen: boolean
    /** Whether the Global Editor's in-editor file tree is rendered.
     *  Only consulted while the overlay is open; otherwise it has no
     *  visible effect. Source of truth is the global-editor store. */
    fileTreeVisible: boolean
    dispatchModeEnabled: boolean
    globalDispatchEnabled: boolean
  }
}

export type CommandDef = {
  id: string
  title: string | ((ctx: CommandContext) => string)
  description: string
  /**
   * The workspace surface this command belongs to. REQUIRED — there is
   * no default on purpose: every command must make a deliberate choice,
   * and TypeScript should fail the build if a new command forgets to.
   * `buildCommandRegistry` uses this to hide `grid` commands while
   * Dispatch Mode is active and `dispatch` commands while it is not,
   * BEFORE the per-command `when` guard runs. `when` remains for
   * data-dependent availability (a session exists, the focused pane is
   * an agent, the overlay is open); `surface` is for mode availability.
   */
  surface: CommandSurface
  shortcut?: string
  keywords?: string[]
  keepPaletteOpen?: boolean
  when?: (ctx: CommandContext) => boolean
  getState?: (ctx: CommandContext) => CommandState | null
  run: (ctx: CommandContext) => void | Promise<void>
}

export type ResolvedCommand = {
  id: string
  title: string
  description: string
  /** Carried through from CommandDef so palette/menu consumers can
   *  group or label by surface without re-importing the raw defs. */
  surface: CommandSurface
  shortcut?: string
  keywords: string[]
  keepPaletteOpen: boolean
  state: CommandState | null
  run: (ctx: CommandContext) => void | Promise<void>
}
