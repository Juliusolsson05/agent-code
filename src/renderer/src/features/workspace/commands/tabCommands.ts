import { panel } from '@renderer/features/command-palette/commandState'
import type { CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

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
    description: '**What it does:** Closes the **project of the agent you are commanding** (the focused lane\'s agent, or the one in Spotlight or Reader) and all its sessions.\n\n**Use when:** You are done with a whole project.\n\n**Notes:** With no agent targeted it closes the highlighted project. Use **Undo Close** if you closed it by mistake.',
    // WHY the command target's project and not `activeTab` (#1013 parity
    // review): the active project is only a label now (U4). Lane focus and
    // index selection never move it, so ⌘⇧W could close the project
    // highlighted in the header while the user worked in another project's
    // lane. A single idle session closes without a dialog, so the wrong
    // project could go with no warning. The session being commanded names
    // the project the user is actually in.
    run: ({ workspace }) => {
      const sessionId = commandTargetSessionId(workspace)
      const projectId = (sessionId ? workspace.state.sessions[sessionId]?.projectId : undefined) ?? workspace.activeTab?.id
      return projectId ? workspace.closeTab(projectId) : undefined
    },
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
    id: 'merge-project-tabs',
    category: 'layout-dispatch',
    surface: 'app',
    title: 'Merge Project Tabs',
    description: '**What it does:** Folds other projects into one. Their agents move to the target\'s index; nothing restarts.\n\n**Use when:** The same folder ended up open in several tabs, or worktree tabs belong together.\n\n**Notes:** Nothing is closed, so anything can be re-arranged afterwards; the dialog lists what moves before you confirm. Moved agents keep their place in the index and, after the next launch, wake on first use like every other pool agent.',
    keywords: ['merge tabs', 'combine tabs', 'duplicate tab', 'same project', 'fold tabs', 'dispatch', 'worktree'],
    when: ({ workspace }) => workspace.state.tabs.length > 1,
    getState: ({ flags }) => panel(flags.mergeProjectTabsOpen),
    run: ({ ui, flags }) => {
      if (flags.mergeProjectTabsOpen) {
        ui.closeMergeProjectTabs()
        return
      }
      ui.openMergeProjectTabs()
    },
  },
  {
    id: 'resume-session',
    category: 'session',
    surface: 'app',
    title: 'Resume Session…',
    description: '**What it does:** Opens the Conversations picker for this repository.\n\n**Use when:** You want to continue a past Claude, Codex or OpenCode conversation.\n\n**Notes:** Lists every worktree of the focused project across all providers; orchestration children are hidden behind a toggle.',
    getState: ({ flags }) => panel(flags.conversationsOpen),
    run: ({ ui, flags }) => {
      // A second press dismisses. The old palette resume mode re-entered
      // itself on a second press, which read as a dead key.
      if (flags.conversationsOpen) {
        ui.closeConversations()
        return
      }
      ui.openConversations({ focusSearch: false })
      ui.closePalette()
    },
  },
]
