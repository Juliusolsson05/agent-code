import { ipcMain, shell } from 'electron'
import { dirname } from 'path'
import { lstat } from 'fs/promises'

import type { AgentCodeConventionsService } from '@main/agentCodeConventions/AgentCodeConventionsService.js'
import type {
  AgentCodeConventionsConflictResolution,
  ClearAgentCodeConventionsRequest,
  SaveAgentCodeConventionsRequest,
} from '@shared/types/agentCodeConventions.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isResolution(value: unknown): value is AgentCodeConventionsConflictResolution {
  return isRecord(value)
    && typeof value.targetId === 'string'
    && value.targetId.length > 0
    && typeof value.expectedConflictFingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(value.expectedConflictFingerprint)
}

function parseSaveRequest(value: unknown): SaveAgentCodeConventionsRequest {
  if (!isRecord(value)
    || !isRevision(value.expectedRevision)
    || typeof value.enabled !== 'boolean'
    || typeof value.markdown !== 'string'
    || (value.overwriteTargets !== undefined && (
      !Array.isArray(value.overwriteTargets) || !value.overwriteTargets.every(isResolution)
    ))) {
    throw new Error('Invalid Agent Code conventions save request')
  }
  return value as SaveAgentCodeConventionsRequest
}

function parseClearRequest(value: unknown): ClearAgentCodeConventionsRequest {
  if (!isRecord(value)
    || !isRevision(value.expectedRevision)
    || (value.abandonTargets !== undefined && (
      !Array.isArray(value.abandonTargets) || !value.abandonTargets.every(isResolution)
    ))) {
    throw new Error('Invalid Agent Code conventions clear request')
  }
  return value as ClearAgentCodeConventionsRequest
}

export function registerAgentCodeConventionsIpc(
  service: AgentCodeConventionsService,
): void {
  ipcMain.handle('agent-code-conventions:get', () => service.getSnapshot())
  ipcMain.handle('agent-code-conventions:audit', () => service.audit())
  ipcMain.handle('agent-code-conventions:save', (_event, request: unknown) =>
    service.save(parseSaveRequest(request)))
  ipcMain.handle('agent-code-conventions:disable', (_event, expectedRevision: unknown) => {
    if (!isRevision(expectedRevision)) throw new Error('Invalid conventions revision')
    return service.disable(expectedRevision)
  })
  ipcMain.handle('agent-code-conventions:clear', (_event, request: unknown) =>
    service.clear(parseClearRequest(request)))
  ipcMain.handle('agent-code-conventions:preview', (_event, markdown: unknown) => {
    if (typeof markdown !== 'string') throw new Error('Invalid conventions preview')
    return service.preview(markdown)
  })
  ipcMain.handle('agent-code-conventions:reveal-target', async (_event, targetId: unknown) => {
    if (typeof targetId !== 'string' || targetId.length === 0) {
      return { ok: false, message: 'Unknown conventions target.' }
    }
    const path = await service.resolveRevealTarget(targetId)
    if (!path) return { ok: false, message: 'Unknown conventions target.' }
    const file = await lstat(path).catch(() => null)
    if (file?.isFile()) shell.showItemInFolder(path)
    else {
      const error = await shell.openPath(dirname(path))
      if (error) return { ok: false, message: error }
    }
    return { ok: true }
  })
  ipcMain.handle('agent-code-conventions:reveal-recovery', async () => {
    const path = await service.resolveRecoveryFile()
    if (!path) return { ok: false, message: 'No conventions recovery file exists.' }
    shell.showItemInFolder(path)
    return { ok: true }
  })
  ipcMain.handle('agent-code-conventions:reset-recovery', () => service.resetRecovery())
}
