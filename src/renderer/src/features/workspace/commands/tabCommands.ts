import type { CommandDef } from '@renderer/features/command-palette/types'

export const tabCommands: CommandDef[] = [
  {
    id: 'new-tab',
    title: 'New Tab',
    shortcut: '⌘T',
    run: ({ ui }) => ui.openNewTabPicker(),
  },
  {
    id: 'close-tab',
    title: 'Close Tab',
    shortcut: '⌘⇧W',
    run: ({ workspace }) => {
      if (workspace.activeTab) void workspace.closeTab(workspace.activeTab.id)
    },
  },
  {
    id: 'next-tab',
    title: 'Next Tab',
    shortcut: '⌘]',
    run: ({ workspace }) => workspace.nextTab(),
  },
  {
    id: 'prev-tab',
    title: 'Previous Tab',
    shortcut: '⌘[',
    run: ({ workspace }) => workspace.prevTab(),
  },
  {
    id: 'reorder-tabs',
    title: 'Reorder Tabs',
    keywords: ['move tabs', 'arrange tabs', 'tab order'],
    when: ({ workspace }) => workspace.state.tabs.length > 1,
    run: ({ ui }) => ui.openReorderTabs(),
  },
  {
    id: 'resume-session',
    title: 'Resume Session',
    shortcut: '⌘⇧R',
    keepPaletteOpen: true,
    run: ({ ui }) => ui.enterResumeMode(),
  },
]
