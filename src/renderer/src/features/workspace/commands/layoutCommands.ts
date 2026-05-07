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
  {
    id: 'toggle-dispatch-terminal',
    title: 'Dispatch Terminal',
    description: '**What it does:** Shows or hides the project terminal inside **Dispatch**.\n\n**Use when:** You want shell access beside the selected agent.\n\n**Notes:** The terminal is tied to the active project tab.',
    keywords: ['project terminal', 'right terminal'],
    when: ({ flags }) => flags.dispatchModeEnabled,
    getState: ({ flags }) => ({
      label: flags.dispatchTerminalVisible ? 'On' : 'Off',
      tone: flags.dispatchTerminalVisible ? 'accent' : 'neutral',
    }),
    run: async ({ ui }) => {
      await ui.toggleDispatchTerminal()
    },
  },
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
]
