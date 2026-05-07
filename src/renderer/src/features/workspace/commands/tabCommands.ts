import type { CommandDef } from '@renderer/features/command-palette/types'

export const tabCommands: CommandDef[] = [
  {
    id: 'new-tab',
    title: 'New Tab',
    description: '**What it does:** Creates a **new tab** from a folder you choose.\n\n**Use when:** You want a separate project or workspace context.\n\n**Notes:** Starts a fresh agent in that folder.',
    shortcut: '⌘T',
    run: ({ ui }) => ui.openNewTabPicker(),
  },
  {
    id: 'close-tab',
    title: 'Close Tab',
    description: '**What it does:** Closes the **current tab** and its sessions.\n\n**Use when:** You are done with a whole project tab.\n\n**Notes:** Use **Undo Close** if you closed it by mistake.',
    shortcut: '⌘⇧W',
    run: ({ workspace }) => {
      if (workspace.activeTab) void workspace.closeTab(workspace.activeTab.id)
    },
  },
  {
    id: 'next-tab',
    title: 'Next Tab',
    description: '**What it does:** Moves focus to the **next tab**.\n\n**Use when:** You want quick tab navigation.\n\n**Notes:** Works from the normal workspace surfaces.',
    shortcut: '⌘]',
    run: ({ workspace }) => workspace.nextTab(),
  },
  {
    id: 'prev-tab',
    title: 'Previous Tab',
    description: '**What it does:** Moves focus to the **previous tab**.\n\n**Use when:** You want quick tab navigation.\n\n**Notes:** Works from the normal workspace surfaces.',
    shortcut: '⌘[',
    run: ({ workspace }) => workspace.prevTab(),
  },
  {
    id: 'reorder-tabs',
    title: 'Reorder Tabs',
    description: '**What it does:** Opens a picker to rearrange **tab order**.\n\n**Use when:** Your tabs are in the wrong order.\n\n**Notes:** Changes apply after you confirm the modal.',
    keywords: ['move tabs', 'arrange tabs', 'tab order'],
    when: ({ workspace }) => workspace.state.tabs.length > 1,
    run: ({ ui }) => ui.openReorderTabs(),
  },
  {
    id: 'resume-session',
    title: 'Resume Session',
    description: '**What it does:** Opens the **resume session** flow.\n\n**Use when:** You want to continue an old Claude or Codex session.\n\n**Notes:** Uses the focused project folder as the default.',
    shortcut: '⌘⇧R',
    keepPaletteOpen: true,
    run: ({ ui }) => ui.enterResumeMode(),
  },
]
