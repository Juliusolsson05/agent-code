import type { CommandDef } from '@renderer/features/command-palette/types'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

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
    description: '**What it does:** Splits the screen in half — file tree + code editor on the left, the normal workspace UI (dispatch / tile / spotlight / whatever) on the right.\n\n**Use when:** You want to read or edit project files alongside the focused agent without leaving the current mode.\n\n**Notes:** The editor\'s workspace tracks the *active tab*\'s project — switching tabs to a different project flips the file tree. Switching panes within the same tab does NOT change the editor (the editor was deliberately decoupled from per-pane focus so reading code doesn\'t blow up when you move between agents in the same project). Open tabs are remembered per project (in memory; not persisted across app restarts).\n\n**Shortcut:** ⌘⇧E.',
    keywords: ['editor', 'code', 'files', 'global', 'workspace', 'monaco'],
    getState: ({ flags }) => ({
      label: flags.globalEditorOpen ? 'On' : 'Off',
      tone: flags.globalEditorOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui, flags }) => {
      const editor = useGlobalEditorStore.getState()
      if (editor.aiWorkspaceId && flags.globalEditorOpen) {
        editor.closeAiWorkspace()
        return
      }
      editor.closeAiWorkspace()
      ui.toggleGlobalEditor()
    },
  },
  {
    id: 'open-ai-workspace',
    title: 'Open AI Workspace',
    description: '**What it does:** Opens a curated **AI Workspace** file set in the Global Editor surface.\n\n**Use when:** An agent has attached plans, notes, or review artifacts from multiple worktrees and you want one focused review view.\n\n**Notes:** If more than one AI Workspace exists, you choose which one to open.',
    keywords: ['ai workspace', 'mcp', 'workspace', 'files', 'review', 'worktree', 'global editor'],
    keepPaletteOpen: true,
    run: ({ ui }) => ui.enterAiWorkspaceOpenMode(),
  },
  {
    id: 'create-ai-workspace',
    title: 'Create AI Workspace',
    description: '**What it does:** Creates an empty named **AI Workspace** and opens it in the Global Editor surface.\n\n**Use when:** You want a curated file set ready before an agent starts attaching files.\n\n**Notes:** Agents can also create AI Workspaces through MCP.',
    keywords: ['ai workspace', 'mcp', 'create', 'workspace', 'review'],
    keepPaletteOpen: true,
    run: ({ ui }) => ui.enterAiWorkspaceCreateMode(),
  },
  {
    id: 'clear-ai-workspace',
    title: 'Clear AI Workspace',
    description: '**What it does:** Removes every file reference from an **AI Workspace** without deleting files from disk.\n\n**Use when:** A curated review set is stale but you want to keep the workspace itself.\n\n**Notes:** This only clears Agent Code metadata.',
    keywords: ['ai workspace', 'mcp', 'clear', 'delete', 'files'],
    keepPaletteOpen: true,
    run: ({ ui }) => ui.enterAiWorkspaceClearMode(),
  },
  {
    // WHY a dedicated command rather than a setting:
    //   The file tree is THE most prominent piece of editor chrome
    //   and the one most-likely-to-be-toggled (some users live in
    //   tabs-only, opening files via Cmd+P; others want the tree
    //   always-on as a project map). Surfacing the toggle in the
    //   palette puts it one keystroke from any state instead of
    //   buried under Settings.
    //
    // WHY gated by `globalEditorOpen`:
    //   The command only does anything when the overlay is mounted.
    //   Showing it in the palette while the overlay is off would be
    //   a dead command — the user toggles it, nothing visible
    //   happens, they assume it broke. Gating it via `when` makes
    //   the command appear only in contexts where it's actionable.
    id: 'toggle-file-tree',
    title: 'File Tree',
    description: '**What it does:** Shows or hides the file tree inside the **Global Editor** overlay.\n\n**Use when:** You want more horizontal room for the code area, or you prefer to open files via tabs / search rather than browsing.\n\n**Notes:** Only available while **Global Editor** is on. The choice is global (not per-project) — once hidden, the tree stays hidden across every project until you turn it back on.',
    keywords: ['file tree', 'explorer', 'sidebar', 'editor', 'tree'],
    when: ({ flags }) => flags.globalEditorOpen,
    getState: ({ flags }) => ({
      label: flags.fileTreeVisible ? 'On' : 'Off',
      tone: flags.fileTreeVisible ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleFileTreeVisible(),
  },
]
