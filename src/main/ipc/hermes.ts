import { ipcMain } from 'electron'

import type { HermesConnectionService } from '@main/hermes/service.js'
import { broadcastToWindows } from '@main/window/windowRegistry.js'
import type { HermesConnectionDraft } from '@shared/hermes/types.js'
import type { HermesSshDraft } from '@shared/hermes/ssh.js'

export const HERMES_CONNECTIONS_CHANGED_CHANNEL = 'hermes:connections-changed'

/**
 * Hermes connections (#1482). Same contract as user MCP and provider
 * enablement: mutations return the fresh value AND every change is
 * broadcast, so all windows' Settings and pane headers agree.
 *
 * Arguments are untrusted renderer input: shapes are checked here, the
 * semantic rules (unique names, URL normalization, token binding) live in
 * HermesConnectionService. No handler returns or accepts a credential.
 */
export function registerHermesIpc(service: HermesConnectionService): void {
  service.on('changed', (connections) => broadcastToWindows(HERMES_CONNECTIONS_CHANGED_CHANNEL, connections))

  ipcMain.handle('hermes:list', () => service.list())

  ipcMain.handle('hermes:add', (_evt, draft: unknown) => {
    if (!isDraft(draft)) throw new Error('hermes:add: invalid arguments')
    return service.add(draft)
  })

  ipcMain.handle('hermes:update', (_evt, id: unknown, draft: unknown) => {
    if (!isId(id) || !isDraft(draft)) throw new Error('hermes:update: invalid arguments')
    return service.update(id, draft)
  })

  ipcMain.handle('hermes:remove', (_evt, id: unknown) => {
    if (!isId(id)) throw new Error('hermes:remove: invalid id')
    return service.remove(id)
  })

  ipcMain.handle('hermes:test', (_evt, id: unknown) => {
    if (!isId(id)) throw new Error('hermes:test: invalid id')
    return service.test(id)
  })

  ipcMain.handle('hermes:sign-in', (_evt, id: unknown) => {
    if (!isId(id)) throw new Error('hermes:sign-in: invalid id')
    return service.signIn(id)
  })

  ipcMain.handle('hermes:cancel-sign-in', (_evt, id: unknown) => {
    if (!isId(id)) throw new Error('hermes:cancel-sign-in: invalid id')
    service.cancelSignIn(id)
  })

  ipcMain.handle('hermes:sign-out', (_evt, id: unknown) => {
    if (!isId(id)) throw new Error('hermes:sign-out: invalid id')
    return service.signOut(id)
  })

  // The Telegram thread a new pane follows (#1496). Only the routing key
  // crosses; the REST listing (titles, chat ids of every lane) stays in main.
  ipcMain.handle('hermes:default-lane', (_evt, id: unknown) => {
    if (!isId(id)) throw new Error('hermes:default-lane: invalid id')
    return service.defaultLaneKey(id)
  })

  // Every thread on the server, for the "Change Telegram Thread…" picker
  // (#1501). The listing DOES cross here (names and routing keys), because
  // the user is choosing among them; head ids do not.
  ipcMain.handle('hermes:list-lanes', (_evt, id: unknown) => {
    if (!isId(id)) throw new Error('hermes:list-lanes: invalid id')
    return service.listLanes(id)
  })

  // SSH access to the connection's server (#1528). The draft is shape-
  // checked here; validateSshDraft (in the service) owns the real rules.
  ipcMain.handle('hermes:set-ssh', (_evt, id: unknown, draft: unknown) => {
    if (!isId(id) || (draft !== null && !isSshDraft(draft))) throw new Error('hermes:set-ssh: invalid arguments')
    return service.setSshAccess(id, draft)
  })

  ipcMain.handle('hermes:detect', (_evt, id: unknown) => {
    if (!isId(id)) throw new Error('hermes:detect: invalid id')
    return service.detectHermes(id)
  })

  // Returns a command LINE for the renderer to type into a terminal pane it
  // just opened (plan Ruling 1). The renderer names a connection and a
  // target, never the command: main builds it from the validated record.
  ipcMain.handle('hermes:shell-command', (_evt, id: unknown, target: unknown) => {
    if (!isId(id) || (target !== 'vps' && target !== 'hermes')) throw new Error('hermes:shell-command: invalid arguments')
    return service.shellCommand(id, target)
  })
}

function isSshDraft(value: unknown): value is HermesSshDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as Record<string, unknown>
  const optionalText = (field: unknown) => field === undefined || (typeof field === 'string' && field.length <= 1024)
  return typeof draft.destination === 'string' && draft.destination.length <= 512 &&
    optionalText(draft.port) && optionalText(draft.identityFile) && optionalText(draft.container) &&
    (draft.sudo === undefined || typeof draft.sudo === 'boolean') &&
    (draft.onHost === undefined || typeof draft.onHost === 'boolean')
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
}

function isDraft(value: unknown): value is HermesConnectionDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as Record<string, unknown>
  return typeof draft.name === 'string' && draft.name.length <= 200 &&
    typeof draft.baseUrl === 'string' && draft.baseUrl.length <= 2048
}
