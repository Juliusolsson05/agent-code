import { isProcessSessionKind } from '@shared/types/providerKind'
import { commandTarget } from '@renderer/features/command-palette/commandTarget'
import type { CommandDef } from '@renderer/features/command-palette/types'

// Window-level commands.
//
// WHY this is its own module rather than an entry in `tabCommands`: a window is
// not a tab, and the distinction is load-bearing rather than cosmetic. A tab
// lives inside one workspace; a window IS a workspace, with its own tabs,
// panes, Dispatch, and agents. Keeping them in one file would invite the next
// command to blur that.
//
// Registered immediately after `tabCommands` in the catalog so New Window sits
// beside the tab family in the palette's empty-query browse order, which is
// where someone looking for "new …" will actually look.

export const windowCommands: CommandDef[] = [
  {
    id: 'new-window',
    category: 'create',
    // 'app', not 'grid'/'dispatch': opening a window is meaningful from every
    // workspace mode, and nothing about it depends on the current layout.
    surface: 'app',
    title: 'New Window',
    description: '**What it does:** Opens a **new Agent Code window** with its own tabs and agents.\n\n**Use when:** You want a second workspace, usually on another monitor.\n\n**Notes:** Starts with one agent in your default folder. Windows reopen where you left them.',
    keywords: ['second window', 'monitor', 'display', 'workspace'],
    // Main owns the work: a window has no tabs to consult and no tile tree to
    // mutate, so there is nothing for the renderer to decide. This mirrors how
    // `role: 'close'` stays native while `close-tab` is dispatched — see the
    // header of main/ipc/window.ts.
    run: () => {
      void window.api.newWindow()
    },
  },
  {
    // #1481. Beside New Window so the two window commands browse together.
    id: 'send-to-window',
    category: 'layout-dispatch',
    // `workspace`, like Pin Session: it acts on the focused lane's session
    // (or the right-clicked row) and needs nothing from the current view.
    surface: 'workspace',
    title: 'Send to Window…',
    description: '**What it does:** Moves the focused lane\'s agent or terminal, with its linked and orchestration children, to another open **window**. It appears in that window\'s focused lane, under a project with the same folder (or a new one), and the lane here is cleared.\n\n**Use when:** You want this work on your other monitor, or out of a crowded window.\n\n**Notes:** Nothing restarts: the process, conversation, draft, pin and MCP choices move as they are. Needs a second window (New Window).',
    keywords: ['move', 'lane', 'window', 'monitor', 'display', 'transfer', 'send', 'other window', 'agent'],
    when: ({ workspace, target }) => {
      const sessionId = commandTarget({ workspace, target })
      const meta = sessionId ? workspace.state.sessions[sessionId] : undefined
      // Process sessions only (agents and terminals). An extension view has no
      // backend to route, and its view would need the extension installed and
      // running in the other window: nothing a row move can promise.
      return Boolean(meta && isProcessSessionKind(meta.kind))
    },
    run: ({ workspace, target, ui }) => {
      const sessionId = commandTarget({ workspace, target })
      if (!sessionId) return
      // The target is captured NOW: from the right-click menu it is the
      // clicked row, and focus may move before the user picks a window.
      ui.closePalette()
      ui.openSendToWindow(sessionId)
    },
    contextMenu: { group: 'agent', order: 70 },
  },
]
