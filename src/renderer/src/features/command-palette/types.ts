import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { AgentViewMode, UsageHeaderLevel } from '@renderer/app-state/settings/types'
import type { RenderedViewPolicy } from '@renderer/workspace/agentDisplayMode'
import type { DispatchAttachIntent } from '@renderer/app-state/uiShell/types'

/**
 * What a command's badge MEANS, not how it looks.
 *
 * The old shape was `{label: string; tone?}` and the renderer uppercased every
 * label into one chip, so a boolean, a selected value, contextual information,
 * an unsupported capability and async progress were indistinguishable. See
 * `commandState.ts` for the six concrete defects that produced, and for the
 * constructors — `toggle`, `panel`, `value`, `status` — that build these.
 *
 * TONE IS NOT PART OF THIS TYPE. It is derived by `describeCommandState`, so a
 * caller cannot colour a state independently of what it means.
 */
export type CommandState =
  | {
      kind: 'toggle'
      value: 'on' | 'off' | 'mixed'
      /** Open/Closed instead of On/Off, for panels. */
      vocabulary?: 'open-closed'
      detail?: string
    }
  | {
      kind: 'value'
      label: string
      detail?: string
    }
  | {
      kind: 'status'
      value: 'loading' | 'unavailable' | 'error'
      detail: string
    }

/**
 * The user-facing grouping of a command.
 *
 * WHY this is separate from `surface`: `surface` is a MACHINE applicability
 * dimension — it answers "does this concept exist in the current layout" and
 * drives mode gating. It was also being read as a category by the Settings
 * list, which conflated two unrelated questions: `debug` is simultaneously "a
 * kind of tooling" and "hidden in Dispatch? no". Once one field means both, you
 * cannot reclassify a command's presentation without changing when it applies.
 *
 * The categories below are defined by an OBJECTIVE rule, not by vibes, so two
 * people classifying the same command land in the same place:
 */
export type CommandCategory =
  /** Creates a tab, pane, session, terminal, agent, or durable template. */
  | 'create'
  /** Changes focus, or opens a transient reading/navigation surface. */
  | 'navigate'
  /** Acts on exactly one resolved agent/session. */
  | 'session'
  /** Changes placement, arrangement, membership, pins, or Dispatch scope. */
  | 'layout-dispatch'
  /** Primarily acts on a document, file, editor, or AI Workspace reference. */
  | 'editor-files'
  /** Opens project/workspace inspection and management tools. */
  | 'workspace-tools'
  /** Mirrors a persisted app preference, or opens Settings. */
  | 'preferences'
  /** Diagnostics, recording, raw inspection, or support artifacts. */
  | 'developer'

/**
 * A closed family of commands controlled as ONE product unit.
 *
 * Deliberately not inferred from `category`: the Navigation Commands group is
 * exactly six ids, while the `navigate` category also contains Jump to Latest
 * Message, Spotlight, Reader Mode, Tiled Tabs and Reorder Tabs, which stay
 * ordinary commands. Deriving membership from the category would make a future
 * navigation-adjacent feature silently default-hidden just for reusing a label.
 */
export type CommandGroup = 'navigation'

/** What a command declares it needs, before resolution finds a concrete one. */

/**
 * Whether an invocation may proceed, and how to present a refusal.
 *
 * The `presentation` split is a product decision, recorded here because it is
 * not self-evident: a command that is IRRELEVANT to the current mode should
 * vanish (a grid-spatial "Focus Pane Left" in Dispatch points at nothing the
 * user can see), while a command that is relevant but UNSUPPORTED should stay
 * visible and disabled with its reason. Hiding the second kind is what makes
 * users ask "why is Rewind missing on OpenCode" and find no answer anywhere;
 * a greyed row that says so teaches them the thing they actually wanted to
 * know.
 */
export type CommandAvailability =
  | { available: true }
  | { available: false; reason: string; presentation: 'hide' | 'disable' }

/**
 * Risk classification. Metadata, NOT a category — a destructive command still
 * belongs to Session or Layout for grouping purposes, and folding risk into
 * the category axis would force a "Destructive" bucket that cuts across every
 * functional group and helps nobody find anything.
 */
export type CommandRisk =
  /** Reversible, or has no side effect beyond view state. */
  | 'safe'
  /** Ends processes, deletes data, or cascades. Requires confirmation policy. */
  | 'destructive'


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

/**
 * How visible a command should be in the command PICKER specifically.
 *
 * WHY this is separate from `surface`: `surface` answers "does this
 * command apply to the current mode at all" (a grid command in Dispatch
 * is meaningless and silently hidden). `pickerVisibility` answers a
 * different question — "even when this command IS applicable, should it
 * clutter the fuzzy-search list, or is it niche/dangerous/dev-only
 * enough that we'd rather it stay out of the picker unless the user
 * opts in?" The two are orthogonal: a command can be perfectly
 * applicable (`surface: 'app'`) yet be a debug toggle most users never
 * want surfaced.
 *
 * CRUCIAL invariant: this affects the PICKER LIST ONLY. A non-`default`
 * visibility never disables `run()` — the command remains fully
 * executable via its keybinding or any programmatic call site. Hiding
 * here is purely about list noise, not capability. Breaking that
 * invariant (e.g. gating keybindings on visibility) would turn a
 * cosmetic preference into a functional regression.
 *
 *  - `default`      — shown in the picker (absence of the field ≡ this).
 *  - `advanced`     — hidden from the picker by default; power-user
 *                     command still reachable by keybinding.
 *  - `experimental` — hidden by default; in-progress / unstable.
 *  - `debug`        — hidden by default; developer/diagnostic tooling.
 *
 * The non-`default` tiers are distinct labels rather than a single
 * `hidden` boolean so a future UI can group/explain them, but the
 * registry gate treats every non-`default` value identically: hidden
 * unless an explicit per-command override (or the global
 * showHiddenCommands escape hatch) says otherwise.
 */
export type CommandPickerVisibility = 'default' | 'advanced' | 'experimental' | 'debug'

export type CommandContext = {
  workspace: Workspace
  ui: {
    openNewTabPicker: () => void
    openTileTabs: () => void
    openReorderTabs: () => void
    openSettings: () => void
    /** Open the command palette. Exists so ⌘⇧P has a command to name instead
     *  of a hard-coded callback that nothing could rebind or collision-check. */
    openCommandPalette: () => void
    openViewPrompts: (sessionId: string) => void
    openPromptSearch: () => void
    openAgentActivity: () => void
    /** Open the read-only Keyboard Shortcuts reference. */
    openKeyboardShortcuts: () => void
    openCloseOldAgents: () => void
    openBulkProviderSwitch: () => void
    openRewindPrompt: (sessionId: string) => void
    openAgentViewModePicker: (sessionId: string) => void
    /** Open the Dispatch color-flag swatch picker for a session. */
    openColorFlagPicker: (sessionId: string) => void
    openUsageModal: () => void
    toggleGitBar: () => void
    toggleWorktreesBar: () => void
    toggleDebugPanel: () => void
    toggleFeedDebugPanel: () => void
    toggleProxyDebugPanel: () => void
    toggleHtmlDebugPanel: () => void
    toggleRenderingDebugMode: () => void
    /** Flip workspace-wide feed auto-follow (every visible agent pane). */
    toggleTailAllMode: () => void
    toggleDevDebugPanel: () => void
    toggleAgentStatusPanel: () => void
    togglePerformancePanel: () => void
    toggleRemotePanel: () => void
    toggleCaffeinate: () => Promise<void> | void
    /** Idempotent open. Prefer this over `toggleGlobalEditor` whenever the
     *  intent is "make sure the editor is up" — a toggle driven by a
     *  snapshotted flag closes the editor when the snapshot is stale. */
    openGlobalEditor: () => void
    closeGlobalEditor: () => void
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
    /** Open the Tiled Dispatch tile-count prompt overlay. The overlay
     *  applies the chosen count via workspace.enterTiledDispatch. */
    openTiledDispatchPrompt: () => void
    /** Open the placement overlay in "attach detached session to grid"
     *  mode for the given sessionId. The session must exist in
     *  workspace.state.detachedSessions; the command's `when` guard is
     *  responsible for that check. */
    openDispatchAttach: (intent: DispatchAttachIntent) => void
    /** Open the shared placement overlay in "Linked Agent" mode. The
     *  session id is the parent agent; the overlay only asks for
     *  Claude/Codex and then delegates to workspace.createLinkedAgent. */
    openLinkedAgent: (sessionId: string) => void
    /** Open the Pin Agents multi-select modal. Lives on uiShell as a
     *  transient flag — the draft selection state is owned by the
     *  modal itself, not the store. */
    openPinAgents: () => void
    setAggressiveDebugPersistence: (enabled: boolean) => void
    enterResumeMode: () => void
    enterBuriedMode: () => void
    enterKillBuriedMode: () => void
    enterPromptTemplateMode: () => void
    enterManagePromptTemplateMode: () => void
    enterSavePromptTemplateMode: () => void
    enterAiWorkspaceOpenMode: () => void
    enterAiWorkspaceCreateMode: () => void
    enterAiWorkspaceClearMode: () => void
    closePalette: () => void
  }
  flags: {
    statusModeEnabled: boolean
    worktreeBadgesEnabled: boolean
    usageHeaderEnabled: boolean
    usageHeaderLevel: UsageHeaderLevel
    dangerousAgentsEnabled: boolean
    aggressiveDebugPersistenceEnabled: boolean
    gitBarOpen: boolean
    worktreesBarOpen: boolean
    debugPanelOpen: boolean
    feedDebugPanelOpen: boolean
    proxyDebugPanelOpen: boolean
    htmlDebugPanelOpen: boolean
    renderingDebugMode: boolean
    /** Workspace-wide feed auto-follow is active. Read by BOTH `Tail All`
     *  (its own on/off label) and per-session `Tail`, which must not report
     *  "Off" while the pane it targets is visibly tailing because of this. */
    tailAllMode: boolean
    devDebugEnabled: boolean
    /** The recording CAPABILITY is available (dev-debug on). Gates the
     *  Start/Stop Session Recording and Attach-Recording-Note commands (plan
     *  §7/§7b) so they only surface when the feature is enabled — NOT "recording
     *  is active" (recording is command-driven per session). Mirrors the
     *  main-process DevDebugConfig.sessionRecordingEnabled value. */
    sessionRecordingEnabled: boolean
    devDebugPanelOpen: boolean
    agentStatusPanelOpen: boolean
    performancePanelOpen: boolean
    caffeinateActive: boolean
    caffeinateSupported: boolean
    globalEditorOpen: boolean
    /** Current command-target project. Editor open/search commands use this
     * when the overlay is closed, because activeCwd may still point at the
     * project that was visible before a tab/focus change. */
    focusedCwd: string | null
    /** Whether the Global Editor's in-editor file tree is rendered.
     *  Only consulted while the overlay is open; otherwise it has no
     *  visible effect. Source of truth is the global-editor store. */
    fileTreeVisible: boolean
    /** Whether the Global Editor is in fullscreen (workspace hidden).
     *  Same scoping as fileTreeVisible — global-editor store owns it. */
    editorFullscreen: boolean
    dispatchModeEnabled: boolean
    globalDispatchEnabled: boolean
    /** App-wide agent pane surface policy from Settings. The command registry
     *  uses it to decide whether render-dependent commands are applicable.
     *  Threading it through flags keeps command modules declarative: commands
     *  say what kind of surface they need, while the registry owns the
     *  Terminal/Hybrid availability rule in one place. */
    agentViewMode: AgentViewMode
    /**
     * Sparse per-command picker-visibility overrides, keyed by the
     * command's stable `id`. A present boolean wins over the command's
     * declared `pickerVisibility`: `true` forces the command into the
     * picker, `false` forces it out. Absent ids fall back to the
     * declared default. Source of truth is the persisted
     * `Settings.commandVisibilityOverrides`; it threads through here so
     * the registry's single filter chokepoint can consult it without
     * importing the settings store.
     */
    commandVisibilityOverrides: Record<string, boolean>
    /**
     * Whether the closed Navigation Commands family is picker-eligible.
     * Mirrors `Settings.navigationCommandsEnabled`.
     *
     * Threaded through flags like the override map so the registry's single
     * visibility chokepoint can consult it without importing the settings
     * store. It is a DISCOVERABILITY gate only — see the setting's docstring
     * for why it must never reach execution or keyboard handling.
     */
    navigationCommandsEnabled: boolean
    /**
     * The user's persisted per-command binding overrides. Threaded through
     * flags so the registry can render EFFECTIVE bindings — the chord that
     * will actually run — rather than a static authored string.
     */
    commandKeybindingOverrides: Record<string, string[]>
    /**
     * Global escape hatch: when true, the picker shows EVERY applicable
     * command regardless of declared visibility or per-command override.
     * Lets a "show hidden commands" affordance reveal the full list in
     * one shot. Wired to a constant `false` for now (issue #249 ships the
     * mechanism only); a future toggle can flip it.
     */
    showHiddenCommands: boolean
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
  /**
   * Declared picker visibility. OPTIONAL on purpose: absence ≡
   * `'default'` (shown), so this stays purely additive — no existing
   * command has to be touched, and the field only appears on commands
   * that genuinely want to hide themselves from the picker by default.
   * A per-command override in settings can still flip this either way;
   * see `CommandContext.flags.commandVisibilityOverrides`.
   */
  pickerVisibility?: CommandPickerVisibility
  /** Whether this command needs Agent Code's rendered feed surface.
   *
   * WHY this is separate from `surface` and `pickerVisibility`:
   * `surface` answers workspace-layout applicability, while
   * `pickerVisibility` is only command-palette list noise. Agent View Mode is
   * a capability constraint: hard Terminal mode intentionally refuses features
   * that depend on rendered feed DOM or feed scroll ownership, while Hybrid can
   * allow feature commands that acquire a temporary rendered-view lease. */
  renderedViewPolicy?: RenderedViewPolicy
  /**
   * User-facing grouping. Optional during the governance migration and made
   * REQUIRED once every command declares one (Phase 3) — flipping it to
   * required before the 102 assignments exist would break the build between
   * two commits that are each meant to be independently revertable.
   */
  category?: CommandCategory
  /** Closed family this command belongs to, controlled as one product unit. */
  commandGroup?: CommandGroup
  /** Risk classification, used by confirmation policy. Absent means `'safe'`. */
  risk?: CommandRisk
  /**
   * Why this command cannot run right now, when that is worth SAYING rather
   * than silently hiding.
   *
   * Returning `null` means "no objection" and lets ordinary admission decide.
   * A command only needs this when the refusal is worth explaining: an
   * unsupported provider capability, an empty undo stack, an unsupported
   * platform. Mode-irrelevance never needs it — the surface gate already hides
   * those, and explaining them would add noise to every mode switch.
   */
  unavailableReason?: (ctx: CommandContext) => CommandUnavailable | null
  keywords?: string[]
  keepPaletteOpen?: boolean
  when?: (ctx: CommandContext) => boolean
  getState?: (ctx: CommandContext) => CommandState | null
  run: (ctx: CommandContext) => void | Promise<void>
}

/** The unavailable half of `CommandAvailability`, as a command declares it. */
export type CommandUnavailable = {
  reason: string
  presentation: 'hide' | 'disable'
}

export type ResolvedCommand = {
  id: string
  title: string
  description: string
  /** Carried through from CommandDef so palette/menu consumers can
   *  group or label by surface without re-importing the raw defs. */
  surface: CommandSurface
  /**
   * The chord this command will actually run, in display form, or undefined
   * when it has none.
   *
   * DERIVED at resolve time from the effective binding set, never authored.
   * It used to be a hand-written `CommandDef.shortcut` string with no
   * relationship to the code that ran, so the palette could advertise a chord
   * the editor implemented and a user's Settings edit changed nothing.
   */
  shortcut?: string
  keywords: string[]
  keepPaletteOpen: boolean
  state: CommandState | null
  run: (ctx: CommandContext) => void | Promise<void>
}
