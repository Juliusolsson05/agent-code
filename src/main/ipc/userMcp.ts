import { ipcMain } from 'electron'

import type { UserMcpService } from '@main/userMcp/service.js'
import { broadcastToWindows } from '@main/window/windowRegistry.js'
import { isUserMcpProvider, isUserMcpServerId, type UserMcpSaveInput } from '@shared/userMcp/types.js'
import { isPlainObject } from '@shared/userMcp/validate.js'

export const USER_MCP_CHANGED_CHANNEL = 'user-mcp:changed'
export const USER_MCP_UNAVAILABLE_CHANNEL = 'user-mcp:unavailable'

// Pasted configs are small; anything larger is not an MCP snippet and would
// only cost a JSON parse in main.
const MAX_IMPORT_CHARS = 256 * 1024
const MAX_SECRET_CHARS = 64 * 1024

/**
 * User MCP servers (#1143). Same contract as provider enablement: every
 * mutation returns the fresh snapshot AND broadcasts it, so every window's
 * Settings grid and per-agent picker update even though only one was touched.
 *
 * Arguments are untrusted renderer input. The shapes are checked here; the
 * semantic rules (names, transports, secret placement) are enforced again in
 * UserMcpService.save, which is the single place that decides what is valid.
 */
export function registerUserMcpIpc(service: UserMcpService): void {
  ipcMain.handle('user-mcp:get', () => service.snapshot())

  ipcMain.handle('user-mcp:save', (_evt, input: unknown) => {
    if (!isSaveInput(input)) throw new Error('user-mcp:save: invalid arguments')
    return service.save(input)
  })

  ipcMain.handle('user-mcp:delete', (_evt, id: unknown) => {
    if (!isUserMcpServerId(id)) throw new Error('user-mcp:delete: invalid id')
    return service.delete(id)
  })

  ipcMain.handle('user-mcp:set-enabled', (_evt, id: unknown, enabled: unknown) => {
    if (!isUserMcpServerId(id) || typeof enabled !== 'boolean') throw new Error('user-mcp:set-enabled: invalid arguments')
    return service.setEnabled(id, enabled)
  })

  ipcMain.handle('user-mcp:set-provider', (_evt, id: unknown, provider: unknown, enabled: unknown) => {
    if (!isUserMcpServerId(id) || !isUserMcpProvider(provider) || typeof enabled !== 'boolean') {
      throw new Error('user-mcp:set-provider: invalid arguments')
    }
    return service.setProvider(id, provider, enabled)
  })

  ipcMain.handle('user-mcp:set-secret', (_evt, id: unknown, inputId: unknown, value: unknown) => {
    if (
      !isUserMcpServerId(id) || typeof inputId !== 'string' ||
      typeof value !== 'string' || value.length > MAX_SECRET_CHARS
    ) {
      throw new Error('user-mcp:set-secret: invalid arguments')
    }
    return service.setSecret(id, inputId, value)
  })

  ipcMain.handle('user-mcp:import', (_evt, text: unknown, fallbackName: unknown) => {
    if (typeof text !== 'string' || text.length > MAX_IMPORT_CHARS) throw new Error('user-mcp:import: invalid text')
    return service.importConfig(text, typeof fallbackName === 'string' ? fallbackName : undefined)
  })

  ipcMain.handle('user-mcp:copy-native', (_evt, provider: unknown, name: unknown) => {
    if (!isUserMcpProvider(provider) || typeof name !== 'string') throw new Error('user-mcp:copy-native: invalid arguments')
    return service.copyNative(provider, name)
  })

  service.onChange(snapshot => broadcastToWindows(USER_MCP_CHANGED_CHANNEL, snapshot))
}

function isSaveInput(value: unknown): value is UserMcpSaveInput {
  if (!isPlainObject(value)) return false
  if (value.id !== undefined && !isUserMcpServerId(value.id)) return false
  if (typeof value.name !== 'string' || typeof value.enabled !== 'boolean') return false
  if (!isPlainObject(value.providers) || !isPlainObject(value.entry) || !Array.isArray(value.inputs)) return false
  if (value.secrets !== undefined) {
    if (!isPlainObject(value.secrets)) return false
    for (const secret of Object.values(value.secrets)) {
      if (typeof secret !== 'string' || secret.length > MAX_SECRET_CHARS) return false
    }
  }
  return true
}
