import { BrowserWindow, Menu, clipboard, shell, dialog } from 'electron'
import { DEVICE_PRESETS, type DevicePresetId } from '@shared/browserPocket/devices.js'
import type { PocketMenuAction, PocketMenuState } from '@shared/browserPocket/types.js'
import { isAllowedTopLevelUrl } from '@shared/browserPocket/url.js'

type Item = Electron.MenuItemConstructorOptions

/** Native menus solve keyboard traversal, focus, submenus and screen-edge
 * placement together. A DOM imitation painted over a guest solved none of
 * these and fell below the window in the user's multi-row workspace. */
export function pocketMenuTemplate(state: PocketMenuState, choose: (action: PocketMenuAction) => void): Item[] {
  const item = (label: string, action: PocketMenuAction, enabled = true): Item => ({ label, enabled, click: () => choose(action) })
  const radio = (label: string, action: PocketMenuAction, checked: boolean): Item => ({ ...item(label, action), type: 'radio', checked })
  return [
    item('Back', 'back', state.canGoBack),
    item('Forward', 'forward', state.canGoForward),
    item('Pick element for agent', 'pick', state.hasPage),
    item('Open in default browser', 'external', state.hasPage),
    { type: 'separator' },
    { label: 'Viewport', submenu: [
      radio('Fit pane', 'device:fill', state.viewport === 'fill'),
      ...(Object.keys(DEVICE_PRESETS) as DevicePresetId[]).map(id => radio(`${DEVICE_PRESETS[id].label} — ${DEVICE_PRESETS[id].width} × ${DEVICE_PRESETS[id].height}`, `device:${id}`, state.viewport === id)),
      { type: 'separator' }, item('Rotate device', 'rotate', state.viewport in DEVICE_PRESETS),
    ] },
    { label: 'Appearance', submenu: (['system', 'light', 'dark'] as const).map(s => radio(s[0]!.toUpperCase() + s.slice(1), `scheme:${s}`, state.colorScheme === s)) },
    { label: `Page zoom (${Math.round(state.zoom * 100)}%)`, submenu: [item('Zoom in', 'zoom-in'), item('Zoom out', 'zoom-out'), item('Actual size', 'zoom-reset')] },
    { label: 'Cookies and storage', submenu: [radio('This agent only', 'profile:lane', state.profile === 'lane'), radio('Shared with project', 'profile:project', state.profile === 'project'), { type: 'separator' }, item('Clear cookies and storage…', 'clear-storage')] },
    { type: 'separator' },
    item('Reload without cache', 'reload', state.hasPage), item('Open DevTools', 'devtools', state.hasPage),
    item('Agent browser setup…', 'setup'),
    { type: 'separator' }, item('Remove pocket and its private storage…', 'detach'),
  ]
}

export function showPocketMenu(sender: Electron.WebContents, state: PocketMenuState): Promise<PocketMenuAction | null> {
  const window = BrowserWindow.fromWebContents(sender)
  if (!window) return Promise.resolve(null)
  return new Promise(resolve => {
    let selected = false
    const menu = Menu.buildFromTemplate(pocketMenuTemplate(state, action => {
      selected = true
      if (action !== 'clear-storage' && action !== 'detach') { resolve(action); return }
      // A close icon used to silently erase private logins. Removal lives in
      // the menu now, and the destructive meaning is explicit before consent.
      void dialog.showMessageBox(window, {
        type: 'question', buttons: ['Cancel', action === 'detach' ? 'Remove pocket' : 'Clear storage'],
        defaultId: 0, cancelId: 0,
        message: action === 'detach' ? 'Remove this browser pocket?' : 'Clear cookies and storage?',
        detail: action === 'detach'
          ? 'Private pocket logins will be removed. Shared project storage is kept.'
          : state.profile === 'project' ? 'This signs out all pockets sharing this project’s cookies.' : 'This signs out this pocket.',
      }).then(result => resolve(result.response === 1 ? action : null), () => resolve(null))
    }))
    // Closing the window while a native menu is open must settle the invoke.
    const closed = () => resolve(null)
    window.once('closed', closed)
    menu.popup({ window, callback: () => { window.removeListener('closed', closed); if (!selected) resolve(null) } })
  })
}

/** Chromium supplies the selection, edit capability flags and frame. Let its
 * native edit roles preserve undo, rich clipboard and IME behavior; do not
 * inject DOM selection/copy scripts into arbitrary web applications. */
export function attachGuestContextMenu(guest: Electron.WebContents): void {
  guest.on('context-menu', (_event, params) => {
    const items: Item[] = []
    if (params.isEditable) {
      items.push({ role: 'undo', enabled: params.editFlags.canUndo }, { role: 'redo', enabled: params.editFlags.canRedo }, { type: 'separator' })
    }
    if (params.isEditable || params.selectionText) {
      if (params.isEditable) items.push({ role: 'cut', enabled: params.editFlags.canCut })
      items.push({ role: 'copy', enabled: params.editFlags.canCopy })
      if (params.isEditable) items.push({ role: 'paste', enabled: params.editFlags.canPaste }, { role: 'selectAll', enabled: params.editFlags.canSelectAll })
      items.push({ type: 'separator' })
    }
    if (params.linkURL && isAllowedTopLevelUrl(params.linkURL)) {
      items.push({ label: 'Open link in default browser', click: () => { void shell.openExternal(params.linkURL) } }, { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' })
    }
    const alive = (fn: () => void) => () => { if (!guest.isDestroyed()) fn() }
    const loading = guest.isLoading()
    items.push(
      { label: 'Back', enabled: guest.navigationHistory.canGoBack(), click: alive(() => guest.navigationHistory.goBack()) },
      { label: 'Forward', enabled: guest.navigationHistory.canGoForward(), click: alive(() => guest.navigationHistory.goForward()) },
      { label: loading ? 'Stop' : 'Reload', click: alive(() => loading ? guest.stop() : guest.reload()) },
      { type: 'separator' }, { label: 'Inspect element', click: alive(() => guest.inspectElement(params.x, params.y)) },
    )
    const window = guest.hostWebContents && BrowserWindow.fromWebContents(guest.hostWebContents)
    if (window) Menu.buildFromTemplate(items).popup({ window, frame: params.frame ?? undefined })
  })
}
