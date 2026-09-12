import { ipcMain, webContents, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { isExtensionJson, runtimeHostRequestSchema } from '@shared/types/extensionRuntime.js'
import { extensionRevision } from '@shared/types/extensions.js'
import { readLedger } from './ledger.js'
import type { ExtensionRuntimeService } from './runtimeService.js'
import type { ExtensionCapabilityService } from './capabilityService.js'
import { ExtensionRuntimeViews } from './runtimeViews.js'

export function registerExtensionRuntimeIpc(
  service: ExtensionRuntimeService,
  capabilities: ExtensionCapabilityService,
  isApplicationContents: (contents: WebContents) => boolean,
): () => void {
  const owners = new Map<number, { generation: number; dispose(): void }>()
  const views = new ExtensionRuntimeViews(service, (owner, event) => {
    const contents = webContents.fromId(owner)
    if (!contents || contents.isDestroyed() || !isApplicationContents(contents)) throw new Error('Extension view owner disappeared.')
    contents.send('extensions:runtime-view', event)
  })

  function authenticate(event: IpcMainInvokeEvent): { owner: number; assertCurrent(): void } {
    if (!isApplicationContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Extension host requests require a registered application main frame.')
    const owner = event.sender.id
    if (!owners.has(owner)) {
      const close = () => { views.detachOwner(owner); owners.get(owner)?.dispose() }
      // A reload keeps the WebContents id but replaces every document and broker.
      // Drop old ownership before navigation, not only when the native window
      // closes, so old pending calls cannot feed the replacement renderer.
      const navigate = (_event: Electron.Event, _url: string, sameDocument: boolean, isMainFrame: boolean) => {
        if (isMainFrame && !sameDocument) {
          views.detachOwner(owner)
          const current = owners.get(owner)
          if (current) current.generation += 1
        }
      }
      event.sender.once('destroyed', close)
      event.sender.on('did-start-navigation', navigate)
      owners.set(owner, { generation: 0, dispose() {
        event.sender.removeListener('destroyed', close)
        event.sender.removeListener('did-start-navigation', navigate)
        owners.delete(owner)
      } })
    }
    const record = owners.get(owner)!
    const generation = record.generation
    return { owner, assertCurrent() {
      if (owners.get(owner) !== record || record.generation !== generation || event.sender.isDestroyed() || !isApplicationContents(event.sender)) throw new Error('Extension view owner document changed.')
    } }
  }

  ipcMain.handle('extensions:runtime-host', async (event, raw: unknown) => {
    const { owner, assertCurrent } = authenticate(event)
    if (!isExtensionJson(raw)) throw new Error('Extension host request exceeds the JSON limits.')
    const request = runtimeHostRequestSchema.parse(raw)
    if (request.method === 'command' || request.method === 'view.attach' || request.method === 'service') {
      const entry = (await readLedger()).find(candidate => candidate.manifest.id === request.extensionId)
      if (!entry || extensionRevision(entry) !== request.revision || entry.manifest.apiVersion !== 2) throw new Error('This installation does not support the managed extension runtime.')
      // ensure() rechecks the same generation under the publication lock. This
      // earlier version check is only an ABI gate, never the authority snapshot.
    }
    assertCurrent()
    switch (request.method) {
      case 'command': return service.invokeCommand(request.extensionId, request.revision, request.commandId)
      case 'view.attach': return views.attach(owner, request.connectionId, request.extensionId, request.revision, request.viewId)
      case 'view.request': return views.request(owner, request.connectionId, request.name, request.input)
      case 'view.detach': views.detach(owner, request.connectionId); return
      case 'service': return capabilities.invoke(request.extensionId, request.revision, request.request)
    }
  })
  return () => {
    ipcMain.removeHandler('extensions:runtime-host')
    views.dispose()
    for (const owner of owners.values()) owner.dispose()
  }
}
