import type { CommandDef } from '@renderer/features/command-palette/types'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'
import {
  requestSaveActiveEditorFile,
  requestSaveAllEditorFiles,
} from '@renderer/features/editor/lib/editorCommandEvents'
import { cancelAllPendingGlobalEditorFileOpens } from '@renderer/features/global-editor/openFileInGlobalEditor'

// Global Editor command module.
//
// WHY these live here and not in workspace/commands/layoutCommands: the
// palette registry aggregates per-FEATURE modules, and every other
// feature owns its commands (reader, spotlight, settings, …). Editor
// commands were squatting in the workspace feature because the editor
// predates the convention — which meant "where do I add an editor
// command" had no answer (#513 isolation). New editor commands go HERE.
//
// WHY several run() bodies reach into useGlobalEditorStore.getState()
// directly instead of the ui bridge: the store IS the editor feature's
// API — these commands live in the same feature as the store, so the
// bridge would only add indirection for state that never leaves the
// feature. The ui bridge is still used for uiShell-owned state
// (globalEditorOpen) because that state is NOT editor-scoped.

export const globalEditorCommands: CommandDef[] = [
  {
    id: 'toggle-global-editor',
    // `app`: the Global Editor overlay WRAPS whatever workspace layout
    // is active (grid, Dispatch, tiled) rather than replacing it, so
    // toggling it is meaningful in every mode.
    surface: 'app',
    title: 'Global Editor',
    description:
      "**What it does:** Splits the screen in half — file tree + code editor on the left, the normal workspace UI (dispatch / tile / spotlight / whatever) on the right.\n\n**Use when:** You want to read or edit project files alongside the focused agent without leaving the current mode.\n\n**Notes:** The editor's workspace tracks the *active tab*'s project — switching tabs to a different project flips the file tree. Switching panes within the same tab does NOT change the editor (the editor was deliberately decoupled from per-pane focus so reading code doesn't blow up when you move between agents in the same project). Open tabs are remembered per project and restored across app restarts (file contents are re-read from disk; unsaved edits are not persisted).\n\n**Shortcut:** ⌘⇧E.",
    keywords: ['editor', 'code', 'files', 'global', 'workspace', 'monaco'],
    getState: ({ flags }) => ({
      label: flags.globalEditorOpen ? 'On' : 'Off',
      tone: flags.globalEditorOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui, flags }) => {
      ui.toggleGlobalEditor()
    },
  },
  {
    id: 'save-editor-file',
    surface: 'editor',
    title: 'Save Editor File',
    description:
      '**What it does:** Saves the active file in the visible Global Editor or AI Workspace.\n\n**Use when:** You edited a file and want to persist it without leaving the command palette.\n\n**Notes:** Conflict checks and recovery are owned by the active editor surface.\n\n**Shortcut:** ⌘S.',
    keywords: ['save', 'write', 'editor', 'file'],
    shortcut: '⌘S',
    when: ({ flags }) => flags.globalEditorOpen,
    run: requestSaveActiveEditorFile,
  },
  {
    id: 'save-all-editor-files',
    surface: 'editor',
    title: 'Save All Editor Files',
    description:
      '**What it does:** Saves every modified file in the visible project editor or AI Workspace.\n\n**Use when:** A review or refactor changed several open tabs and you want one explicit persistence action.\n\n**Notes:** Each file keeps its own optimistic conflict check. Failed/conflicted files remain modified and surface a warning in their tab; deleted files are never recreated implicitly.',
    keywords: ['save all', 'write', 'editor', 'files', 'modified'],
    when: ({ flags }) => flags.globalEditorOpen,
    run: requestSaveAllEditorFiles,
  },
  {
    id: 'quick-open-file',
    surface: 'editor',
    title: 'Quick Open File',
    description:
      "**What it does:** Fuzzy-finds a file by name in the focused agent's project and opens it in the **Global Editor**.\n\n**Use when:** You know (roughly) the file name and don't want to click through the tree.\n\n**Notes:** Opens the editor overlay if it isn't already open. The index skips junk directories (node_modules, build output, VCS internals) and caps at 20k files.\n\n**Shortcut:** ⌘P.",
    keywords: ['quick open', 'go to file', 'find file', 'fuzzy', 'open file'],
    shortcut: '⌘P',
    when: ({ flags }) => Boolean(useGlobalEditorStore.getState().activeCwd ?? flags.focusedCwd),
    run: ({ ui, flags }) => {
      const editor = useGlobalEditorStore.getState()
      const targetCwd = flags.globalEditorOpen
        ? (editor.activeCwd ?? flags.focusedCwd)
        : (flags.focusedCwd ?? editor.activeCwd)
      if (!targetCwd) return
      if (editor.activeCwd !== targetCwd) cancelAllPendingGlobalEditorFileOpens()
      editor.setActiveCwd(targetCwd)
      editor.showProjectEditor()
      if (!flags.globalEditorOpen) ui.toggleGlobalEditor()
      editor.setQuickOpenOpen(true)
    },
  },
  {
    id: 'search-in-files',
    surface: 'editor',
    title: 'Search in Files',
    description:
      "**What it does:** Searches file contents across the focused agent's project and opens matches in the **Global Editor** at the matched line.\n\n**Use when:** You're hunting a string or identifier across the project.\n\n**Notes:** Bounded scan (skips >1MB files and junk dirs; caps at 500 matches / 20k files). Case-sensitivity toggle lives in the overlay.\n\n**Shortcut:** ⌘⇧F.",
    keywords: ['search', 'grep', 'find in files', 'content search', 'ripgrep'],
    shortcut: '⌘⇧F',
    when: ({ flags }) => Boolean(useGlobalEditorStore.getState().activeCwd ?? flags.focusedCwd),
    run: ({ ui, flags }) => {
      const editor = useGlobalEditorStore.getState()
      const targetCwd = flags.globalEditorOpen
        ? (editor.activeCwd ?? flags.focusedCwd)
        : (flags.focusedCwd ?? editor.activeCwd)
      if (!targetCwd) return
      if (editor.activeCwd !== targetCwd) cancelAllPendingGlobalEditorFileOpens()
      editor.setActiveCwd(targetCwd)
      editor.showProjectEditor()
      if (!flags.globalEditorOpen) ui.toggleGlobalEditor()
      editor.setContentSearchOpen(true)
    },
  },
  {
    id: 'toggle-editor-fullscreen',
    surface: 'editor',
    title: 'Editor Fullscreen',
    description:
      '**What it does:** Expands the **Global Editor** to fill the whole workspace area. The normal workspace stays alive underneath (hidden, not unmounted — terminals and feeds keep running).\n\n**Use when:** You want maximum reading/editing room for a while.\n\n**Notes:** Esc exits fullscreen; the previous split ratio is restored.\n\n**Shortcut:** ⌥⌘E.',
    keywords: ['fullscreen', 'maximize', 'editor', 'zen', 'focus'],
    shortcut: '⌥⌘E',
    when: ({ flags }) => flags.globalEditorOpen,
    getState: ({ flags }) => ({
      label: flags.editorFullscreen ? 'On' : 'Off',
      tone: flags.editorFullscreen ? 'accent' : 'neutral',
    }),
    run: () => useGlobalEditorStore.getState().toggleEditorFullscreen(),
  },
  {
    id: 'open-ai-workspace',
    surface: 'editor',
    title: 'Open AI Workspace',
    description:
      '**What it does:** Opens a curated **AI Workspace** file set in the Global Editor surface.\n\n**Use when:** An agent has attached plans, notes, or review artifacts from multiple worktrees and you want one focused review view.\n\n**Notes:** If more than one AI Workspace exists, you choose which one to open.',
    keywords: ['ai workspace', 'mcp', 'workspace', 'files', 'review', 'worktree', 'global editor'],
    keepPaletteOpen: true,
    run: ({ ui }) => ui.enterAiWorkspaceOpenMode(),
  },
  {
    id: 'create-ai-workspace',
    surface: 'editor',
    title: 'Create AI Workspace',
    description:
      '**What it does:** Creates an empty named **AI Workspace** and opens it in the Global Editor surface.\n\n**Use when:** You want a curated file set ready before an agent starts attaching files.\n\n**Notes:** Agents can also create AI Workspaces through MCP.',
    keywords: ['ai workspace', 'mcp', 'create', 'workspace', 'review'],
    keepPaletteOpen: true,
    run: ({ ui }) => ui.enterAiWorkspaceCreateMode(),
  },
  {
    id: 'clear-ai-workspace',
    surface: 'editor',
    title: 'Clear AI Workspace',
    description:
      '**What it does:** Removes every file reference from an **AI Workspace** without deleting files from disk.\n\n**Use when:** A curated review set is stale but you want to keep the workspace itself.\n\n**Notes:** This only clears Agent Code metadata.',
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
    // `editor`: not mode-gated (the editor overlay is orthogonal to
    // grid/Dispatch); the `when: globalEditorOpen` guard below still
    // hides it until the overlay is actually mounted.
    surface: 'editor',
    title: 'File Tree',
    description:
      '**What it does:** Shows or hides the file tree inside the **Global Editor** overlay.\n\n**Use when:** You want more horizontal room for the code area, or you prefer to open files via tabs / search rather than browsing.\n\n**Notes:** Only available while **Global Editor** is on. The choice is global (not per-project) — once hidden, the tree stays hidden across every project until you turn it back on.',
    keywords: ['file tree', 'explorer', 'sidebar', 'editor', 'tree'],
    when: ({ flags }) => flags.globalEditorOpen,
    getState: ({ flags }) => ({
      label: flags.fileTreeVisible ? 'On' : 'Off',
      tone: flags.fileTreeVisible ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleFileTreeVisible(),
  },
]
