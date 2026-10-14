import { ipcMain } from 'electron'

import type { SidekickService } from '@main/sidekicks/SidekickService.js'
import { broadcastToWindows, windowIdFor } from '@main/window/windowRegistry.js'
import { isSidekickId, SIDEKICK_CHANNELS } from '@shared/sidekicks/types.js'
import type { SidekickAttachResult, SidekickWriteResult } from '@shared/sidekicks/types.js'

/**
 * Sidekick IPC (#1493). Arguments are untrusted renderer input: shapes are
 * checked here, the ownership rules (I2/I3: who holds which lease) live in
 * SidekickService. The requesting window is ALWAYS derived from the sender,
 * never taken from an argument — a renderer naming another window's id is
 * exactly the forgery the lease checks exist to refuse.
 *
 * Every change is broadcast as a full SidekickIndexView, like Hermes
 * connections: there are a handful of sidekicks, and a full view keeps
 * every window's picker and panel header from disagreeing after a missed
 * delta.
 */
export function registerSidekickIpc(service: SidekickService): void {
  service.on('changed', view => broadcastToWindows(SIDEKICK_CHANNELS.changed, view))

  ipcMain.handle(SIDEKICK_CHANNELS.list, () => service.view())

  ipcMain.handle(SIDEKICK_CHANNELS.register, async (evt, request: unknown): Promise<SidekickWriteResult> => {
    const windowId = windowIdFor(evt.sender)
    if (!windowId) return { ok: false, reason: 'window-gone' }
    if (!isRecord(request) || !isSidekickId(request.id) || !isSessionId(request.sessionId)) {
      return { ok: false, reason: 'invalid arguments' }
    }
    return await service.register(windowId, { id: request.id, sessionId: request.sessionId, meta: request.meta ?? null })
  })

  ipcMain.handle(SIDEKICK_CHANNELS.save, async (evt, request: unknown): Promise<SidekickWriteResult> => {
    const windowId = windowIdFor(evt.sender)
    if (!windowId) return { ok: false, reason: 'window-gone' }
    if (!isRecord(request) || !isSidekickId(request.id) || !isSessionId(request.sessionId)) {
      return { ok: false, reason: 'invalid arguments' }
    }
    // A draft is composer text; bound it so a runaway paste cannot balloon
    // workspace.json (the window slice's drafts have no bound either, but they
    // are cleared on send — a sidekick draft is written on every pause).
    const draft = typeof request.draft === 'string' ? request.draft.slice(0, 200_000) : undefined
    return await service.save(windowId, {
      id: request.id,
      sessionId: request.sessionId,
      meta: request.meta ?? null,
      ...(draft !== undefined ? { draft } : {}),
    })
  })

  ipcMain.handle(SIDEKICK_CHANNELS.attach, (evt, id: unknown): SidekickAttachResult => {
    const windowId = windowIdFor(evt.sender)
    if (!windowId) return { ok: false, reason: 'window-gone' }
    if (!isSidekickId(id)) return { ok: false, reason: 'not-found' }
    return service.attach(windowId, id)
  })

  ipcMain.handle(SIDEKICK_CHANNELS.take, (evt, id: unknown): SidekickAttachResult => {
    const windowId = windowIdFor(evt.sender)
    if (!windowId) return { ok: false, reason: 'window-gone' }
    if (!isSidekickId(id)) return { ok: false, reason: 'not-found' }
    return service.take(windowId, id)
  })

  ipcMain.handle(SIDEKICK_CHANNELS.remove, async (evt, id: unknown, caller: unknown): Promise<SidekickWriteResult> => {
    const windowId = windowIdFor(evt.sender)
    if (!windowId) return { ok: false, reason: 'window-gone' }
    if (!isSidekickId(id)) return { ok: false, reason: 'not-found' }
    return await service.remove(windowId, id, caller === 'sidekick.register-failed' ? 'sidekick.register-failed' : 'sidekick.remove')
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}
