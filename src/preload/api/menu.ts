import { subscribe } from '@preload/api/ipc.js'
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
}
