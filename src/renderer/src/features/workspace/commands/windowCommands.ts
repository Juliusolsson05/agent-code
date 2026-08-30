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
    description: '**What it does:** Opens a **new Agent Code window** with its own tabs and agents.\n\n**Use when:** You want a second workspace, usually on another monitor.\n\n**Notes:** The new window starts empty. Windows reopen where you left them.',
    keywords: ['second window', 'monitor', 'display', 'workspace'],
    // Main owns the work: a window has no tabs to consult and no tile tree to
    // mutate, so there is nothing for the renderer to decide. This mirrors how
    // `role: 'close'` stays native while `close-tab` is dispatched — see the
    // header of main/ipc/window.ts.
    run: () => {
      void window.api.newWindow()
    },
  },
]
