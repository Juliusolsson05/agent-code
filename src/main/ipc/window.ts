import { ipcMain } from 'electron'

import type { WorkspaceFileStore } from '@main/storage/workspaceFileStore.js'
import { createAppWindow } from '@main/window/windowRegistry.js'

// Window-chrome IPC.
//
// WHY creating a window is main's job rather than a renderer command that main
// merely obeys: a window is not workspace state. It has no tabs to consult, no
// tile tree to mutate, and nothing about it depends on the requesting
// renderer's store — which is exactly the test `appMenu.ts` already applies
// when it keeps `role: 'close'` native while dispatching `close-tab` to the
// renderer.
//
// The command exists in the palette anyway, because that is where this app's
// users look for anything and it is what makes the action rebindable. Both
// entry points land here.

export function registerWindowIpc(store: WorkspaceFileStore): void {
  ipcMain.handle('window:new', () => {
    // A brand-new window gets a fresh id and therefore no persisted slice, so
    // its renderer takes the same `workspace:load → null` path as a fresh
    // install: one default agent in the default cwd. That is the intended
    // meaning of New Window — an empty workspace, not a copy of this one.
    createAppWindow()
  })

  ipcMain.handle('window:adoption-complete', async (_evt, windowId: string) => {
    // The adopting renderer has merged the closed window's workspace into its
    // own state, so the closed slice can finally be dropped. Doing this any
    // earlier would open a window in which neither the file nor any live
    // renderer holds those sessions — a crash there would lose them.
    await store.removeWindow(windowId)
  })
}
