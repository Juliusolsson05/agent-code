import { ipcMain, shell } from 'electron'
import { lstat } from 'node:fs/promises'

import type { AgentCodeConventionsService } from '@main/agentCodeConventions/AgentCodeConventionsService.js'
import { SKILL_INSTALL_INPUT_MAX_LENGTH } from '@shared/skills/installSource.js'
import { isAgentProviderKind } from '@shared/types/providerKind.js'
import {
  type ApplyAgentCodeInstalledSkillUpdateRequest,
  type DeleteAgentCodeInstalledSkillRequest,
  type InstallAgentCodeGitHubSkillsRequest,
  type SetAgentCodeInstalledSkillEnabledRequest,
  type SetAgentCodeInstalledSkillProvidersRequest,
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
    // WHY no upper count (#1161): the service accepts only ids that belong to
    // one staged discovery, so that discovery already bounds this list. A
    // numeric cap here was a second, invented skills limit.
    || !value.candidateIds.every(isId)
    || !isProviderList(value.providers, true)) {
    throw new Error('Invalid installed skill request')
  }
  return value as InstallAgentCodeGitHubSkillsRequest
}

function isProviderList(value: unknown, optional: boolean): boolean {
  if (value === undefined) return optional
  if (value === null) return !optional
  return Array.isArray(value) && value.length > 0 && value.every(isAgentProviderKind)
}

function parseProviders(value: unknown): SetAgentCodeInstalledSkillProvidersRequest {
  if (!isRecord(value)
    || !isRevision(value.expectedRevision)
    || !isId(value.skillId)
    || !isProviderList(value.providers, false)) {
    throw new Error('Invalid installed skill providers request')
  }
  return value as SetAgentCodeInstalledSkillProvidersRequest
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
  // Takes anything the Add dialog accepts — an `npx skills add …` command,
  // owner/repo, a GitHub or skills.sh URL — and main parses it (#1161). The
  // bound is for one pasted command, which can list many --skill names.
  ipcMain.handle('agent-code-installed-skills:discover', (_event, value: unknown) => {
    if (typeof value !== 'string' || value.length > SKILL_INSTALL_INPUT_MAX_LENGTH) {
      throw new Error('Invalid skill install input')
    }
    return service.discoverGitHubSkills(value)
  })
  ipcMain.handle('agent-code-installed-skills:set-providers', (_event, value: unknown) =>
    service.setInstalledSkillProviders(parseProviders(value)))
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
