import { ipcMain } from 'electron'

import { showPopupMenu } from '@main/menu/popupMenu.js'
import type { PopupMenuRequest } from '@shared/types/popupMenu.js'

// Generic native popup menu (#1180). The renderer sends a data-only template
// and gets back the id of the item chosen, or null. See
// shared/types/popupMenu.ts for why this is one channel for every surface
// rather than a main-side menu per feature.
export function registerMenuIpc(): void {
  ipcMain.handle('menu:popup', (event, request: PopupMenuRequest) => {
    // Main frame only, like agentNames/ipc.ts and the control host: extension
    // content runs in sub-frames of the same WebContents, and a menu that
    // appears over the app is app chrome an extension must not be able to
    // stage — its labels would read as ours.
    if (event.senderFrame !== event.sender.mainFrame) return null
    return showPopupMenu(event.sender, request)
  })
}
