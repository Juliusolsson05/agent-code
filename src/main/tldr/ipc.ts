import { ipcMain } from 'electron'
import { z } from 'zod'
import { validTldrIdentity } from '@shared/types/tldr.js'
import type { TldrUpdate } from '@shared/types/tldr.js'
import type { TldrStore } from './TldrStore.js'
import type { TldrEnforcement } from './enforcement.js'
import { broadcastToWindows, getBrowserWindow, windowIdFor } from '@main/window/windowRegistry.js'
import { ensureMacHotkeyHelperBinary } from '@main/dictation/macHotkeyHelper.js'
import { watchMacTldrRelease } from './holdRelease.js'

export function registerTldrIpc(store: TldrStore, enforcement: Pick<TldrEnforcement, 'status'>): void {
  // Warm the development build without delaying the first peek. This only
  // resolves/builds our bundled executable; it starts no keyboard observer.
  const helper = process.platform === 'darwin' ? ensureMacHotkeyHelperBinary() : null
  void helper?.catch(() => {})
  const holds = new Map<number, { token: string; cancel: () => void }>()
  const holdRequest = z.object({ code: z.string().max(32), token: z.string().uuid() })
  ipcMain.on('tldr:hold-start', (event, raw: unknown) => {
    const windowId = windowIdFor(event.sender)
    const window = windowId ? getBrowserWindow(windowId) : null
    if (!helper || !window?.isFocused() || event.senderFrame !== event.sender.mainFrame) return
    const parsed = holdRequest.safeParse(raw)
    if (!parsed.success) return
    const { code, token } = parsed.data
    const senderId = event.sender.id
    holds.get(senderId)?.cancel()
    const finish = () => {
      if (holds.get(senderId)?.token !== token) return
      holds.get(senderId)?.cancel()
      if (!event.sender.isDestroyed()) event.sender.send('tldr:hold-released', token)
    }
    const stop = watchMacTldrRelease(helper, code, finish)
    const cancel = () => {
      stop()
      window.removeListener('blur', finish)
      window.removeListener('closed', finish)
      event.sender.removeListener('did-start-navigation', finish)
      if (holds.get(senderId)?.token === token) holds.delete(senderId)
    }
    holds.set(senderId, { token, cancel })
    window.once('blur', finish)
    window.once('closed', finish)
    event.sender.once('did-start-navigation', finish)
  })
  ipcMain.on('tldr:hold-stop', (event, token: unknown) => {
    const hold = holds.get(event.sender.id)
    if (hold && hold.token === token) hold.cancel()
  })
  const identities = z.array(z.string().refine(validTldrIdentity)).max(10_000)
  const identity = z.string().refine(validTldrIdentity)
  const assertApplicationWindow = (event: Electron.IpcMainInvokeEvent) => {
    const windowId = windowIdFor(event.sender)
    if (!windowId || !getBrowserWindow(windowId) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('TLDR requires a registered application window.')
    }
  }
  ipcMain.handle('tldr:read', (event, raw: unknown) => {
    assertApplicationWindow(event)
    return store.read(identities.parse(raw))
  })
  ipcMain.handle('tldr:history', (event, raw: unknown) => {
    assertApplicationWindow(event)
    return store.history(identity.parse(raw))
  })
  // Read-only, like every renderer TLDR API: whether this identity's provider
  // hooks have reached main. The renderer uses it to say when enforcement is not
  // running; it can never mark a hook as having fired.
  ipcMain.handle('tldr:enforcement', (event, raw: unknown) => {
    assertApplicationWindow(event)
    return enforcement.status(identities.parse(raw))
  })
  // Renderer APIs are read-only. Only the authenticated MCP scope can write;
  // neither a model-supplied target ID nor a UI convenience method bypasses it.
  store.on('changed', (update: TldrUpdate) => broadcastToWindows('tldr:changed', update))
}
