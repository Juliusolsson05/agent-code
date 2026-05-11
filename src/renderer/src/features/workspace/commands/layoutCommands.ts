import type { CommandDef } from '@renderer/features/command-palette/types'

export const layoutCommands: CommandDef[] = [
  {
    id: 'dispatch-mode',
    title: 'Dispatch Mode',
    description: '**What it does:** Toggles the **Dispatch** command-center layout.\n\n**Use when:** You want to scan and command agents from a compact list.\n\n**Notes:** Shows the selected agent, the agent list, and an optional project terminal.',
    keywords: ['agent list', 'focused agent', 'command center'],
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
    title: 'Global Dispatch',
    description: '**What it does:** Switches **Dispatch** between project scope and all-tabs scope.\n\n**Use when:** You want one command center for agents across every tab.\n\n**Notes:** Only appears while **Dispatch Mode** is enabled.',
    keywords: ['dispatch all tabs', 'agent list'],
    when: ({ flags }) => flags.dispatchModeEnabled,
    getState: ({ flags }) => ({
      label: flags.globalDispatchEnabled ? 'On' : 'Off',
      tone: flags.globalDispatchEnabled ? 'accent' : 'neutral',
    }),
    run: async ({ ui }) => {
      await ui.enterGlobalDispatch()
    },
  },
  {
    id: 'exit-dispatch-mode',
    title: 'Exit Dispatch Mode',
    description: '**What it does:** Leaves **Dispatch** and returns to the normal grid layout.\n\n**Use when:** You are done using the command-center view.\n\n**Notes:** Detached **Dispatch** agents stay parked until you attach them.',
    keywords: ['grid mode', 'normal layout'],
    when: ({ flags }) => flags.dispatchModeEnabled,
    run: ({ ui }) => ui.exitDispatchMode(),
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
    title: 'Normalize Layout',
    description: '**What it does:** Rebalances pane sizes in the current layout.\n\n**Use when:** Panes feel uneven but the layout shape is still useful.\n\n**Notes:** Keeps the same split structure.',
    run: ({ workspace }) => workspace.normalizeLayout(),
  },
  {
    id: 'hard-normalize-layout',
    title: 'Hard Normalize Layout',
    description: '**What it does:** Rebuilds pane sizing into a cleaner even layout.\n\n**Use when:** The layout is messy and needs a stronger reset.\n\n**Notes:** More aggressive than **Normalize Layout**.',
    run: ({ workspace }) => workspace.hardNormalizeLayout(),
  },
  {
    id: 'rotate-layout',
    title: 'Rotate Layout',
    description: '**What it does:** Rotates split directions in the current layout.\n\n**Use when:** The same panes would work better in a different orientation.\n\n**Notes:** Keeps the sessions, changes the arrangement.',
    run: ({ workspace }) => workspace.rotateLayout(),
  },
  {
    id: 'toggle-status-mode',
    title: 'Status Mode',
    description: '**What it does:** Toggles status coloring for active agents.\n\n**Use when:** You want running or working agents to stand out.\n\n**Notes:** This is a visual setting only.',
    getState: ({ flags }) => ({
      label: flags.statusModeEnabled ? 'On' : 'Off',
      tone: flags.statusModeEnabled ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleStatusMode(),
  },
  {
    id: 'toggle-performance-panel',
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
    id: 'toggle-global-editor',
    title: 'Global Editor',
    description: '**What it does:** Splits the screen in half — file tree + code editor on the left, the normal workspace UI (dispatch / tile / spotlight / whatever) on the right.\n\n**Use when:** You want to read or edit project files alongside the focused agent without leaving the current mode.\n\n**Notes:** The editor\'s workspace tracks the focused agent\'s cwd — switching agents to a different project flips the file tree. Open tabs are remembered per project (in memory; not persisted across app restarts).\n\n**Shortcut:** ⌘⇧E.',
    keywords: ['editor', 'code', 'files', 'global', 'workspace', 'monaco'],
    getState: ({ flags }) => ({
      label: flags.globalEditorOpen ? 'On' : 'Off',
      tone: flags.globalEditorOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleGlobalEditor(),
  },
]
