import { useAppStore } from '@renderer/app-state/store'
import { toggle } from '@renderer/features/command-palette/commandState'
import type { CommandDef } from '@renderer/features/command-palette/types'

// Sidekick commands (#1493). Titles are noun phrases (docs/command-style.md):
// "Sidekick" is the panel, the way "Agent Status" is its panel.
//
// WHY these act on the panel and never on a "command target": palette
// commands keep resolving to the focused LANE in v1 (plan ruling, Task 5),
// so ~150 session commands cannot reach a sidekick by accident — Close,
// Spotlight, Pin and Merge into Project all assume a project. The panel's
// own header carries the few actions a sidekick needs (Switch, Reload,
// Remove, Hide).

export const sidekickCommands: CommandDef[] = [
  {
    id: 'sidekick-panel',
    category: 'workspace-tools',
    surface: 'app',
    title: 'Sidekick',
    description: '**What it does:** Shows the **Sidekick** panel at the right edge of the window and puts the keyboard in it; pressed again while you are typing there, hides it.\n\n**Use when:** You want your global agent — Hermes, or any agent started in your home folder — beside whatever project is open.\n\n**Notes:** A sidekick belongs to no project or lane. It is live in one window at a time; another window shows "Open here".',
    keywords: ['sidekick', 'global', 'agent', 'hermes', 'side', 'panel', 'right', 'home'],
    getState: ({ workspace }) => toggle(workspace.state.sidekickPanel?.open === true),
    run: ({ workspace, ui }) => {
      ui.closePalette()
      const store = useAppStore.getState()
      const open = workspace.state.sidekickPanel?.open === true
      // Three states, one chord: closed → open + keyboard; open but the
      // keyboard elsewhere → take the keyboard; already typing in it → hide.
      if (!open) {
        workspace.setSidekickPanel({ open: true })
        store.setKeyboardRegion('sidekick')
      } else if (store.keyboardRegion !== 'sidekick') {
        store.setKeyboardRegion('sidekick')
      } else {
        workspace.setSidekickPanel({ open: false })
        store.setKeyboardRegion('workspace')
      }
    },
  },
  {
    id: 'sidekick-picker',
    category: 'navigate',
    surface: 'app',
    title: 'Sidekick Picker…',
    description: '**What it does:** Lists your **sidekicks** and switches the Sidekick panel to the one you choose, or creates a new one.\n\n**Use when:** You keep more than one global agent (for example Hermes and a Claude session in your home folder).\n\n**Notes:** Lists only sidekicks, never lane agents. ⌘⌫ in the picker removes the highlighted sidekick.',
    keywords: ['sidekick', 'picker', 'switch', 'global', 'agent', 'hermes'],
    run: ({ workspace, ui }) => {
      ui.closePalette()
      workspace.setSidekickPanel({ open: true })
      useAppStore.getState().openSidekickPicker('switch')
    },
  },
  {
    id: 'new-sidekick',
    category: 'create',
    surface: 'app',
    title: 'New Sidekick…',
    description: '**What it does:** Creates a **sidekick**: a global agent of the kind you choose, started in your home folder and shown in the Sidekick panel.\n\n**Use when:** You want an agent that is not part of any project — Hermes from your VPS, or Claude/Codex for errands outside a repository.\n\n**Notes:** Hermes needs a signed-in connection under Settings → Hermes.',
    keywords: ['new', 'sidekick', 'global', 'agent', 'hermes', 'create', 'home'],
    run: ({ workspace, ui }) => {
      ui.closePalette()
      workspace.setSidekickPanel({ open: true })
      useAppStore.getState().openSidekickPicker('create')
    },
  },
]
