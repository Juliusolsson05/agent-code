import { Menu, type MenuItemConstructorOptions } from 'electron'

import { sendToMainWindow } from '@main/window/mainWindow.js'

// macOS application menu (issue #148).
//
// WHY File-menu items dispatch command IDs instead of doing work in main:
//
// Every "File" action (New Tab, Resume Session, Reorder Tabs, Close Tab) is
// already a first-class command in the renderer's command registry, where it
// runs against a live CommandContext — the workspace store plus the bag of UI
// callbacks (openNewTabPicker, enterResumeMode, …). Main has NO model of tabs,
// folders, or the resume flow; it manages PTYs and shuffles bytes (see the
// header in main/index.ts). Re-implementing these behaviors in main would mean
// duplicating the workspace store across the process boundary — exactly the
// thing the single-primary-process design avoids.
//
// So the menu does the minimum: it emits the command's stable string `id` over
// `menu:command`, and the renderer (CommandPalette, which owns the resolved
// `commands` memo and the live context) looks the id up and runs it. The menu
// is a thin remote control; the renderer remains the single source of truth for
// what each command means. Adding a File item is "pick an existing id" — no new
// behavior, no new IPC handler.
//
// WHY no accelerators on the dispatched items:
//
// The renderer's useKeybinds already binds ⌘T (new-tab), ⌘⇧R (resume-session),
// ⌘⇧W (close-tab), etc. If we ALSO set the same accelerators on these menu
// items, the chord would fire twice — once through Electron's menu accelerator
// path and once through the renderer keydown handler — double-opening pickers
// or double-closing tabs. Native role items (quit, close window, reload, …)
// keep their standard accelerators because those are owned by the menu, not the
// renderer. The menu items still SHOW no shortcut hint, which is acceptable:
// the chords are discoverable in the command palette, and the menu's job here
// is mouse-driven discoverability, not a second keybinding surface.

/** Emit a renderer command id over the menu:command channel. The renderer's
 *  live CommandContext resolves and runs it. */
function dispatchCommand(commandId: string): void {
  sendToMainWindow('menu:command', commandId)
}

export function buildAppMenu(): Menu {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    // App menu (the bold "Agent Code" menu) — macOS only. The `appMenu` role
    // expands to the standard About/Services/Hide/HideOthers/Unhide/Quit block
    // with platform-correct labels and accelerators (⌘Q, ⌘H). On non-mac we
    // skip this whole submenu; Quit lives elsewhere there.
    ...(isMac
      ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          // → renderer command `new-tab` (tabCommands.ts). No accelerator: the
          // renderer already binds ⌘T; see the file-level WHY above.
          click: () => dispatchCommand('new-tab'),
        },
        {
          label: 'Resume Session…',
          // → renderer command `resume-session`. Opens the resume picker for
          // the focused project's history.
          click: () => dispatchCommand('resume-session'),
        },
        { type: 'separator' },
        {
          label: 'Reorder Tabs…',
          // → renderer command `reorder-tabs`. The command's own `when` guard
          // (>1 tab) lives in the renderer; the menu always dispatches and the
          // command no-ops when not applicable.
          click: () => dispatchCommand('reorder-tabs'),
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          // → renderer command `close-tab`. No accelerator (renderer binds ⌘⇧W).
          click: () => dispatchCommand('close-tab'),
        },
        // Close Window is a genuine window-chrome action that main owns, so it
        // keeps the native role and its standard ⌘W accelerator.
        { role: 'close' },
      ],
    },
    // Standard Edit menu — undo/redo/cut/copy/paste/selectAll with correct
    // platform accelerators. Without an explicit Edit menu, ⌘C/⌘V/⌘X stop
    // working in the renderer's text inputs on macOS, because those system edit
    // shortcuts are routed THROUGH the application menu. Re-adding the role
    // menu restores them.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    // Standard Window menu — minimize/zoom/front, plus the window list on mac.
    { role: 'windowMenu' },
  ]

  return Menu.buildFromTemplate(template)
}
