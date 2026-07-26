import type { CommandDef } from '@renderer/features/command-palette/types'

export const layoutCommands: CommandDef[] = [
  {
    id: 'dispatch-mode',
    category: 'layout-dispatch',
    // `app`, not `dispatch`: this is the toggle that ENTERS and EXITS
    // Dispatch, so it must be visible in both modes — surface-gating it
    // to `dispatch` would make it impossible to turn Dispatch on.
    surface: 'app',
    title: 'Dispatch Mode',
    description: '**What it does:** Toggles the **Dispatch** command-center layout.\n\n**Use when:** You want to scan and command agents from a compact list.\n\n**Notes:** Shows the selected agent, the agent list, and an optional project terminal. Run again to return to the normal grid.',
    keywords: ['agent list', 'focused agent', 'command center', 'exit dispatch', 'grid mode', 'normal layout'],
    getState: ({ flags }) => ({
      label: flags.dispatchModeEnabled
        ? (flags.globalDispatchEnabled ? 'Global' : 'Project')
        : 'Off',
      tone: flags.dispatchModeEnabled ? 'accent' : 'neutral',
    }),
    run: async ({ ui, flags }) => {
      if (flags.dispatchModeEnabled) {
        ui.exitDispatchMode()
        return
      }
      await ui.enterDispatchMode()
    },
  },
  {
    id: 'global-dispatch',
    category: 'layout-dispatch',
    // `dispatch` surface replaces the old `when: dispatchModeEnabled`
    // guard — the registry's surface gate already hides this whenever
    // Dispatch is off, so the explicit `when` was redundant.
    surface: 'dispatch',
    title: 'Global Dispatch',
    description: '**What it does:** Switches **Dispatch** between project scope and all-tabs scope.\n\n**Use when:** You want one command center for agents across every tab.\n\n**Notes:** Only appears while **Dispatch Mode** is enabled.',
    keywords: ['dispatch all tabs', 'agent list'],
    getState: ({ flags }) => ({
      label: flags.globalDispatchEnabled ? 'On' : 'Off',
      tone: flags.globalDispatchEnabled ? 'accent' : 'neutral',
    }),
    run: async ({ ui }) => {
      await ui.enterGlobalDispatch()
    },
  },
  {
    id: 'tiled-dispatch',
    category: 'layout-dispatch',
    // `app`, like the Dispatch toggle: Tiled Dispatch enters (and is the
    // adjust-count path for) the multi-lane Dispatch layout, so it should be
    // reachable from the grid as well as from Dispatch.
    surface: 'app',
    title: 'Tiled Dispatch',
    description: '**What it does:** Opens a multi-lane **Dispatch** layout — the full agent index plus several live agent lanes side by side.\n\n**Use when:** You want to watch and drive multiple agents at once.\n\n**Notes:** Prompts for a tile count (1–10). The leftmost lane is the full index; every other lane has its own compact selector. Re-run to change the tile count (existing lane selections are preserved). Return to the normal grid with **Dispatch Mode**.',
    keywords: ['tiled dispatch', 'multi agent', 'lanes', 'split dispatch', 'cockpit', 'parallel agents', 'grid of agents'],
    run: ({ ui }) => ui.openTiledDispatchPrompt(),
  },
  // REMOVED: 'toggle-dispatch-terminal' command. The dispatch project
  // terminal is now controlled by `settings.dispatchProjectTerminal`
  // (default OFF) rather than a per-session command-palette toggle. The
  // old command sat on top of an ephemeral `dispatchMode.terminalVisible`
  // flag that re-defaulted to ON every time dispatch was re-entered,
  // producing the "I turned it off but it came back" failure mode.
  // Search settings → "Attach Project Terminal to Dispatch" to toggle.
  {
    id: 'normalize-layout',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    // `grid`: this rebalances `tab.root` split ratios. Dispatch does not
    // render the grid, so in Dispatch this was a silent no-op (issue
    // #228). Surface-gating hides it there instead of running invisibly.
    surface: 'grid',
    title: 'Normalize Layout',
    description: '**What it does:** Rebalances pane sizes in the current layout.\n\n**Use when:** Panes feel uneven but the layout shape is still useful.\n\n**Notes:** Keeps the same split structure.',
    run: ({ workspace }) => workspace.normalizeLayout(),
  },
  {
    id: 'hard-normalize-layout',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    surface: 'grid',
    title: 'Hard Normalize Layout',
    description: '**What it does:** Rebuilds pane sizing into a cleaner even layout.\n\n**Use when:** The layout is messy and needs a stronger reset.\n\n**Notes:** More aggressive than **Normalize Layout**.',
    run: ({ workspace }) => workspace.hardNormalizeLayout(),
  },
  {
    id: 'rotate-layout',
    category: 'layout-dispatch',
    pickerVisibility: 'advanced',
    surface: 'grid',
    title: 'Rotate Layout',
    description: '**What it does:** Rotates split directions in the current layout.\n\n**Use when:** The same panes would work better in a different orientation.\n\n**Notes:** Keeps the sessions, changes the arrangement.',
    run: ({ workspace }) => workspace.rotateLayout(),
  },
  // RETIRED: `toggle-status-mode`. Status Mode is a persisted app preference
  // with no meaningful momentary scope — there is no "just for this session"
  // version of it — so it has one product home, and that home is Settings
  // (Appearance → Status Mode, backed by `showStatusMode`). A command that
  // duplicates a durable preference gives the same setting two owners and two
  // places to look when it is wrong.
  {
    id: 'toggle-performance-panel',
    category: 'developer',
    pickerVisibility: 'debug',
    surface: 'debug',
    title: 'Performance Stats',
    description: '**What it does:** Shows or hides the performance stats panel.\n\n**Use when:** You want render, pane, or runtime performance details.\n\n**Notes:** Mostly useful while debugging the app.',
    keywords: ['performance', 'stats', 'cpu', 'memory', 'panes'],
    getState: ({ flags }) => ({
      label: flags.performancePanelOpen ? 'On' : 'Off',
      tone: flags.performancePanelOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.togglePerformancePanel(),
  },
  {
    id: 'toggle-caffeinate',
    category: 'workspace-tools',
    surface: 'app',
    title: 'Caffeinate',
    description: '**What it does:** Toggles a macOS `caffeinate` process so long-running agent work can prevent idle/system sleep.\n\n**Use when:** You want Agent Code to keep the machine awake while agents run.\n\n**Notes:** macOS lid-close behavior is hardware and power-state dependent; this command does not guarantee work keeps running after the lid is closed.',
    keywords: ['sleep', 'awake', 'macos', 'power', 'long running', 'idle'],
    getState: ({ flags }) => ({
      label: flags.caffeinateSupported
        ? (flags.caffeinateActive ? 'On' : 'Off')
        : 'Unsupported',
      tone: flags.caffeinateActive ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleCaffeinate(),
  },
  // Editor commands (toggle-global-editor, quick-open, AI workspace,
  // file tree, fullscreen) moved to
  // features/global-editor/commands/globalEditorCommands.ts — the editor
  // feature owns its own palette module now (#513 isolation).
]
