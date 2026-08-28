import { ipcMain, shell } from 'electron'
import { dirname } from 'path'
import { lstat } from 'fs/promises'

import type { AgentCodeConventionsService } from '@main/agentCodeConventions/AgentCodeConventionsService.js'
import type {
  AgentCodeCustomSkillDraft,
  CreateAgentCodeCustomSkillRequest,
  DeleteAgentCodeCustomSkillRequest,
  SetAgentCodeCustomSkillEnabledRequest,
  UpdateAgentCodeCustomSkillRequest,
} from '@shared/types/agentCodeCustomSkills.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function parseDraft(value: unknown): AgentCodeCustomSkillDraft {
  if (!isRecord(value)
    || typeof value.name !== 'string'
    || typeof value.description !== 'string'
    || typeof value.markdown !== 'string'
    || typeof value.enabled !== 'boolean') {
    throw new Error('Invalid custom skill draft')
  }
  return value as AgentCodeCustomSkillDraft
}

function parseCreate(value: unknown): CreateAgentCodeCustomSkillRequest {
  const draft = parseDraft(value)
  if (!isRecord(value) || !isRevision(value.expectedRevision)) {
    throw new Error('Invalid custom skill create request')
  }
  return { ...draft, expectedRevision: value.expectedRevision }
}

function parseUpdate(value: unknown): UpdateAgentCodeCustomSkillRequest {
  if (!isRecord(value)
    || !isRevision(value.expectedRevision)
    || !isId(value.skillId)
    || typeof value.description !== 'string'
    || typeof value.markdown !== 'string'
    || typeof value.enabled !== 'boolean') {
    throw new Error('Invalid custom skill update request')
  }
  return value as UpdateAgentCodeCustomSkillRequest
}

function parseEnabled(value: unknown): SetAgentCodeCustomSkillEnabledRequest {
  if (!isRecord(value)
    || !isRevision(value.expectedRevision)
    || !isId(value.skillId)
    || typeof value.enabled !== 'boolean') {
    throw new Error('Invalid custom skill enabled request')
  }
  return value as SetAgentCodeCustomSkillEnabledRequest
}

function parseDelete(value: unknown): DeleteAgentCodeCustomSkillRequest {
  if (!isRecord(value)
    || !isRevision(value.expectedRevision)
    || !isId(value.skillId)
    || (value.abandonTargets !== undefined && (!Array.isArray(value.abandonTargets)
      || !value.abandonTargets.every(item => isRecord(item)
        && isId(item.targetId)
        && typeof item.expectedConflictFingerprint === 'string'
        && /^[a-f0-9]{64}$/.test(item.expectedConflictFingerprint))))) {
    throw new Error('Invalid custom skill delete request')
  }
  return value as DeleteAgentCodeCustomSkillRequest
}

export function registerAgentCodeCustomSkillsIpc(service: AgentCodeConventionsService): void {
  ipcMain.handle('agent-code-custom-skills:get', () => service.getCustomSkillsSnapshot())
  ipcMain.handle('agent-code-custom-skills:audit', () =>
    service.getCustomSkillsSnapshot({ audit: true }))
  ipcMain.handle('agent-code-custom-skills:create', (_event, value: unknown) =>
    service.createCustomSkill(parseCreate(value)))
  ipcMain.handle('agent-code-custom-skills:update', (_event, value: unknown) =>
    service.updateCustomSkill(parseUpdate(value)))
  ipcMain.handle('agent-code-custom-skills:set-enabled', (_event, value: unknown) =>
    service.setCustomSkillEnabled(parseEnabled(value)))
  ipcMain.handle('agent-code-custom-skills:delete', (_event, value: unknown) =>
    service.deleteCustomSkill(parseDelete(value)))
  ipcMain.handle('agent-code-custom-skills:preview', (_event, value: unknown) =>
    service.previewCustomSkill(parseDraft(value)))
  ipcMain.handle(
    'agent-code-custom-skills:reveal-target',
    async (_event, skillId: unknown, targetId: unknown) => {
      if (!isId(skillId) || !isId(targetId)) return { ok: false, message: 'Unknown skill target.' }
      const path = await service.resolveCustomSkillRevealTarget(skillId, targetId)
      if (!path) return { ok: false, message: 'Unknown skill target.' }
      const file = await lstat(path).catch(() => null)
      if (file?.isFile()) shell.showItemInFolder(path)
      else {
        const error = await shell.openPath(dirname(path))
        if (error) return { ok: false, message: error }
      }
      return { ok: true }
    },
  )
  ipcMain.handle('agent-code-custom-skills:reveal-recovery', async () => {
    const path = await service.resolveRecoveryFile()
    if (!path) return { ok: false, message: 'No managed skill recovery file exists.' }
    shell.showItemInFolder(path)
    return { ok: true }
  })
  ipcMain.handle('agent-code-custom-skills:reset-recovery', () =>
    service.resetCustomSkillsRecovery())
}
