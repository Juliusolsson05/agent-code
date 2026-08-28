import { ipcMain, shell } from 'electron'
import { lstat } from 'node:fs/promises'

import type { AgentCodeConventionsService } from '@main/agentCodeConventions/AgentCodeConventionsService.js'
import {
  AGENT_CODE_INSTALLED_SKILL_MAX_URL_LENGTH,
  type ApplyAgentCodeInstalledSkillUpdateRequest,
  type DeleteAgentCodeInstalledSkillRequest,
  type InstallAgentCodeGitHubSkillsRequest,
  type SetAgentCodeInstalledSkillEnabledRequest,
} from '@shared/types/agentCodeInstalledSkills.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function parseInstall(value: unknown): InstallAgentCodeGitHubSkillsRequest {
  if (!isRecord(value)
    || !isRevision(value.expectedRevision)
    || !isId(value.discoveryId)
    || !Array.isArray(value.candidateIds)
    || value.candidateIds.length === 0
    || value.candidateIds.length > 100
    || !value.candidateIds.every(isId)) {
    throw new Error('Invalid installed skill request')
  }
  return value as InstallAgentCodeGitHubSkillsRequest
}

function parseEnabled(value: unknown): SetAgentCodeInstalledSkillEnabledRequest {
  if (!isRecord(value)
    || !isRevision(value.expectedRevision)
    || !isId(value.skillId)
    || typeof value.enabled !== 'boolean') {
    throw new Error('Invalid installed skill enabled request')
  }
  return value as SetAgentCodeInstalledSkillEnabledRequest
}

function parseDelete(value: unknown): DeleteAgentCodeInstalledSkillRequest {
  if (!isRecord(value)
    || !isRevision(value.expectedRevision)
    || !isId(value.skillId)
    || (value.abandonTargets !== undefined && (!Array.isArray(value.abandonTargets)
      || value.abandonTargets.length > 100
      || !value.abandonTargets.every(item => isRecord(item)
        && isId(item.targetId)
        && typeof item.expectedConflictFingerprint === 'string'
        && /^[a-f0-9]{64}$/.test(item.expectedConflictFingerprint))))) {
    throw new Error('Invalid installed skill delete request')
  }
  return value as DeleteAgentCodeInstalledSkillRequest
}

function parseUpdate(value: unknown): ApplyAgentCodeInstalledSkillUpdateRequest {
  if (!isRecord(value)
    || !isRevision(value.expectedRevision)
    || !isId(value.skillId)
    || !isId(value.discoveryId)
    || !isId(value.candidateId)) {
    throw new Error('Invalid installed skill update request')
  }
  return value as ApplyAgentCodeInstalledSkillUpdateRequest
}

export function registerAgentCodeInstalledSkillsIpc(service: AgentCodeConventionsService): void {
  ipcMain.handle('agent-code-installed-skills:get', () => service.getInstalledSkillsSnapshot())
  ipcMain.handle('agent-code-installed-skills:audit', () =>
    service.getInstalledSkillsSnapshot({ audit: true }))
  ipcMain.handle('agent-code-installed-skills:discover', (_event, value: unknown) => {
    if (typeof value !== 'string' || value.length > AGENT_CODE_INSTALLED_SKILL_MAX_URL_LENGTH) {
      throw new Error('Invalid GitHub skill URL')
    }
    return service.discoverGitHubSkills(value)
  })
  ipcMain.handle('agent-code-installed-skills:install', (_event, value: unknown) =>
    service.installGitHubSkills(parseInstall(value)))
  ipcMain.handle('agent-code-installed-skills:set-enabled', (_event, value: unknown) =>
    service.setInstalledSkillEnabled(parseEnabled(value)))
  ipcMain.handle('agent-code-installed-skills:check-update', (_event, skillId: unknown) => {
    if (!isId(skillId)) throw new Error('Invalid installed skill id')
    return service.checkInstalledSkillForUpdates(skillId)
  })
  ipcMain.handle('agent-code-installed-skills:apply-update', (_event, value: unknown) =>
    service.applyInstalledSkillUpdate(parseUpdate(value)))
  ipcMain.handle('agent-code-installed-skills:delete', (_event, value: unknown) =>
    service.deleteInstalledSkill(parseDelete(value)))
  ipcMain.handle(
    'agent-code-installed-skills:reveal-target',
    async (_event, skillId: unknown, targetId: unknown) => {
      if (!isId(skillId) || !isId(targetId)) return { ok: false, message: 'Unknown skill target.' }
      const path = await service.resolveInstalledSkillRevealTarget(skillId, targetId)
      if (!path) return { ok: false, message: 'Unknown skill target.' }
      const stat = await lstat(path).catch(() => null)
      if (!stat?.isDirectory()) return { ok: false, message: 'Installed skill target no longer exists.' }
      const error = await shell.openPath(path)
      return error ? { ok: false, message: error } : { ok: true }
    },
  )
  ipcMain.handle('agent-code-installed-skills:reveal-source', async (_event, skillId: unknown) => {
    if (!isId(skillId)) return { ok: false, message: 'Unknown installed skill.' }
    const path = await service.resolveInstalledSkillSource(skillId)
    if (!path) return { ok: false, message: 'Installed skill source snapshot is unavailable.' }
    const error = await shell.openPath(path)
    return error ? { ok: false, message: error } : { ok: true }
  })
  ipcMain.handle('agent-code-installed-skills:reveal-recovery', async () => {
    const path = await service.resolveRecoveryFile()
    if (!path) return { ok: false, message: 'No managed skill recovery file exists.' }
    shell.showItemInFolder(path)
    return { ok: true }
  })
  ipcMain.handle('agent-code-installed-skills:reset-recovery', () =>
    service.resetInstalledSkillsRecovery())
}
