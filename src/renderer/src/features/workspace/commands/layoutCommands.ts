import type { CommandDef } from '@renderer/features/command-palette/types'

export const layoutCommands: CommandDef[] = [
  {
    id: 'dispatch-mode',
    title: 'Dispatch Mode',
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
    keywords: ['grid mode', 'normal layout'],
    when: ({ flags }) => flags.dispatchModeEnabled,
    run: ({ ui }) => ui.exitDispatchMode(),
  },
  {
    id: 'toggle-dispatch-terminal',
    title: 'Dispatch Terminal',
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
    run: ({ workspace }) => workspace.normalizeLayout(),
  },
  {
    id: 'hard-normalize-layout',
    title: 'Hard Normalize Layout',
    run: ({ workspace }) => workspace.hardNormalizeLayout(),
  },
  {
    id: 'rotate-layout',
    title: 'Rotate Layout',
    run: ({ workspace }) => workspace.rotateLayout(),
  },
  {
    id: 'toggle-status-mode',
    title: 'Status Mode',
    getState: ({ flags }) => ({
      label: flags.statusModeEnabled ? 'On' : 'Off',
      tone: flags.statusModeEnabled ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleStatusMode(),
  },
  {
    id: 'toggle-performance-panel',
    title: 'Performance Stats',
    keywords: ['performance', 'stats', 'cpu', 'memory', 'panes'],
    getState: ({ flags }) => ({
      label: flags.performancePanelOpen ? 'On' : 'Off',
      tone: flags.performancePanelOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.togglePerformancePanel(),
  },
]
