import type { CommandContext } from '@renderer/features/command-palette/types'

// ---------------------------------------------------------------------------
// Narrow test harness for `CommandContext`.
//
// WHY a harness exists at all: `CommandContext` is a large PUBLIC input type —
// a workspace store, ~50 ui callbacks, and ~30 flags. Command admission,
// target resolution, and dispatch policy all consume it, so testing any of
// them means constructing one. Building it inline per test file produced a
// 90-line fixture duplicated across suites, which drifts: two copies with
// different default flags make two tests mean different things while looking
// identical.
//
// WHY it is not a mock of private state: everything here is a value the
// production API already takes as an argument. The harness assembles a
// legitimate context; it does not reach past any encapsulation boundary. The
// seam disappears the day `CommandContext` gets a real builder in product
// code — nothing here would need to survive that.
//
// Lives under src/ rather than testing/support/ because it is feature-local
// (only the command-palette suites use it) and because src/renderer/** is
// already inside the authoritative web tsconfig include, so the harness is
// type-checked by the same gate as the code it describes. It is imported only
// by *.test.ts files and is tree-shaken out of the app bundle.
// ---------------------------------------------------------------------------

export type CommandContextHarnessOptions = {
  /** Session id the Dispatch-aware target resolver should report. Also
   *  registered in `state.sessions` so revalidation finds it. */
  focusedSessionId?: string
  /** Project path exposed through `flags.focusedCwd`. */
  focusedCwd?: string
  activeTabId?: string
  flags?: Partial<CommandContext['flags']>
  /** Receives the name of every ui callback a command reaches for. */
  uiCalls?: string[]
}

/**
 * Build a context that behaves like an empty workspace unless told otherwise.
 *
 * Defaults are chosen so admission is DECIDED BY THE TEST rather than by
 * ambient fixture state: no tabs, no dispatch mode, agent view mode, no
 * visibility overrides. A test that wants a gate to fail must say so.
 */
export function makeTestCommandContext(
  options: CommandContextHarnessOptions = {},
): CommandContext {
  const uiCalls = options.uiCalls ?? []

  // WHY the ui bag is a Proxy rather than ~50 explicit stubs: none of those
  // callbacks' identities affect admission, targeting, or dispatch policy —
  // what matters is whether a command's `run` was reached at all. Fifty
  // hand-written no-ops would need maintaining every time a command is added
  // and would assert nothing extra.
  const ui = new Proxy({} as CommandContext['ui'], {
    get: (_target, prop: string) => (..._args: unknown[]) => {
      uiCalls.push(prop)
    },
  })

  const sessions = options.focusedSessionId
    ? { [options.focusedSessionId]: { kind: 'claude', cwd: '/repo' } }
    : {}

  // A single tab owning the focused session is the minimum shape that makes
  // `commandTargetSessionIdForState` return it: that selector reads the active
  // tab's focusedSessionId when Dispatch is off. Anything less and every
  // session-targeted test would silently resolve to "no target" and pass for
  // the wrong reason.
  const tabs = options.focusedSessionId
    ? [{
        id: options.activeTabId ?? 'tab-1',
        focusedSessionId: options.focusedSessionId,
        root: { type: 'leaf', sessionId: options.focusedSessionId },
      }]
    : []

  const workspace = {
    state: {
      tabs,
      activeTabId: options.activeTabId ?? (tabs.length > 0 ? tabs[0].id : null),
      sessions,
      dispatchMode: null,
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
      relatedAgents: {},
    },
    getRuntime: () => undefined,
    runtimes: {},
    activeTab: tabs[0],
  } as unknown as CommandContext['workspace']

  return {
    workspace,
    ui,
    flags: {
      statusModeEnabled: true,
      worktreeBadgesEnabled: true,
      usageHeaderEnabled: true,
      usageHeaderLevel: 'all',
      dangerousAgentsEnabled: false,
      aggressiveDebugPersistenceEnabled: false,
      gitBarOpen: false,
      worktreesBarOpen: false,
      debugPanelOpen: false,
      feedDebugPanelOpen: false,
      proxyDebugPanelOpen: false,
      htmlDebugPanelOpen: false,
      renderingDebugMode: false,
      tailAllMode: false,
      devDebugEnabled: false,
      sessionRecordingEnabled: false,
      devDebugPanelOpen: false,
      agentStatusPanelOpen: false,
      performancePanelOpen: false,
      caffeinateActive: false,
      caffeinateSupported: true,
      globalEditorOpen: false,
      focusedCwd: options.focusedCwd ?? null,
      fileTreeVisible: false,
      editorFullscreen: false,
      dispatchModeEnabled: false,
      globalDispatchEnabled: false,
      agentViewMode: 'agent',
      commandVisibilityOverrides: {},
      // ON by default here, opposite to the product default. The harness serves
      // suites about admission, targeting and dispatch; leaving the group gate
      // off would make six real commands invisible in tests that never mention
      // it, and a test failing for a reason it does not name is worse than a
      // default that differs from production. Group behavior has its own tests
      // that set this explicitly.
      navigationCommandsEnabled: true,
      commandKeybindingOverrides: {},
      showHiddenCommands: false,
      ...options.flags,
    },
  } as CommandContext
}
