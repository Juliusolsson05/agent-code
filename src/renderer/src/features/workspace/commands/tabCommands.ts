import { panel } from '@renderer/features/command-palette/commandState'
import type { CommandDef } from '@renderer/features/command-palette/types'

export const tabCommands: CommandDef[] = [
  {
    id: 'new-tab',
    category: 'create',
    surface: 'app',
    title: 'New Tab',
    description: '**What it does:** Creates a **new tab** from a folder you choose.\n\n**Use when:** You want a separate project or workspace context.\n\n**Notes:** Starts a fresh agent in that folder.',
    // NOT a toggle. `pathPickerOpen` is the SHARED path modal, not "the new-tab
    // picker" — the resume flow opens the same one with a pre-filled cwd — so a
    // boolean cannot say which request put it there. Escape dismisses it.
    run: ({ ui }) => ui.openNewTabPicker(),
  },
  {
    id: 'close-tab',
    category: 'layout-dispatch',
    surface: 'app',
    title: 'Close Tab',
    description: '**What it does:** Closes the **current tab** and its sessions.\n\n**Use when:** You are done with a whole project tab.\n\n**Notes:** Use **Undo Close** if you closed it by mistake.',
    run: ({ workspace }) =>
      workspace.activeTab ? workspace.closeTab(workspace.activeTab.id) : undefined,
  },
  {
    id: 'next-tab',
    category: 'navigate',
    commandGroup: 'navigation',
    surface: 'app',
    title: 'Next Tab',
    description: '**What it does:** Moves focus to the **next tab**.\n\n**Use when:** You want quick tab navigation.\n\n**Notes:** Works from the normal workspace surfaces.',
    run: ({ workspace }) => workspace.nextTab(),
  },
  {
    id: 'prev-tab',
    category: 'navigate',
    commandGroup: 'navigation',
    surface: 'app',
    title: 'Previous Tab',
    description: '**What it does:** Moves focus to the **previous tab**.\n\n**Use when:** You want quick tab navigation.\n\n**Notes:** Works from the normal workspace surfaces.',
    run: ({ workspace }) => workspace.prevTab(),
  },
  {
    id: 'reorder-tabs',
    category: 'navigate',
    surface: 'app',
    title: 'Reorder Tabs',
    description: '**What it does:** Opens a picker to rearrange **tab order**.\n\n**Use when:** Your tabs are in the wrong order.\n\n**Notes:** Changes apply after you confirm the modal.',
    keywords: ['move tabs', 'arrange tabs', 'tab order'],
    when: ({ workspace }) => workspace.state.tabs.length > 1,
    getState: ({ flags }) => panel(flags.reorderTabsOpen),
    run: ({ ui, flags }) => {
      if (flags.reorderTabsOpen) {
        ui.closeReorderTabs()
        return
      }
      ui.openReorderTabs()
    },
  },
  {
    id: 'resume-session',
    category: 'session',
    surface: 'app',
    title: 'Resume Session',
    description: '**What it does:** Opens the **resume session** flow.\n\n**Use when:** You want to continue an old Claude or Codex session.\n\n**Notes:** Uses the focused project folder as the default.',
    keepPaletteOpen: true,
    run: ({ ui, flags }) => {
      // Already showing this mode? Dismiss. A mode-entering command whose
      // second press re-enters the mode it is already in reads as a dead key,
      // which is the same complaint that started this whole change.
      if (flags.paletteMode === 'resume') {
        ui.closePalette()
        return
      }
      ui.enterResumeMode()
    },
  },
]
