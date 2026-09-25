import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { PopupMenuRequest } from '@shared/types/popupMenu.js'
import type { Unsub } from '@preload/api/types.js'

// Native menu → renderer command dispatch (issue #148).
//
// The macOS application menu's File items live in main (main/menu/appMenu.ts),
// but the behaviors they trigger are renderer command-registry commands that
// only the renderer can run (they need the live CommandContext — workspace
// store + UI callbacks). So main emits the command's string id over
// `menu:command`, and this bridge hands it to the renderer. The renderer
// (CommandPalette) subscribes once, looks the id up in its resolved command
// list, and runs it. This keeps the menu a thin remote control with no
// duplicated workspace model in main.

export const menuApi = {
  onMenuCommand: (cb: (commandId: string) => void): Unsub =>
    subscribe('menu:command', cb),
  /**
   * Show a native popup menu and resolve with the chosen item's id, or null
   * when dismissed (#1180). Main returns only ids the renderer supplied; it
   * never runs anything — the caller maps the id back to its own action.
   */
  showPopupMenu: (request: PopupMenuRequest): Promise<string | null> =>
    ipcRenderer.invoke('menu:popup', request),
}
