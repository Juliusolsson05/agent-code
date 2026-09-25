import { ipcRenderer } from 'electron'

import type {
  AgentCodeInstalledSkillDiscoveryResult,
  AgentCodeInstalledSkillsMutationResult,
  AgentCodeInstalledSkillsSnapshot,
  AgentCodeInstalledSkillUpdateResult,
  ApplyAgentCodeInstalledSkillUpdateRequest,
  DeleteAgentCodeInstalledSkillRequest,
  InstallAgentCodeGitHubSkillsRequest,
  SetAgentCodeInstalledSkillEnabledRequest,
  SetAgentCodeInstalledSkillProvidersRequest,
} from '@shared/types/agentCodeInstalledSkills.js'

export const agentCodeInstalledSkillsApi = {
  getAgentCodeInstalledSkills: (): Promise<AgentCodeInstalledSkillsSnapshot> =>
    ipcRenderer.invoke('agent-code-installed-skills:get'),
  auditAgentCodeInstalledSkills: (): Promise<AgentCodeInstalledSkillsSnapshot> =>
    ipcRenderer.invoke('agent-code-installed-skills:audit'),
  /** Accepts an `npx skills add …` command, owner/repo, or a GitHub/skills.sh URL. */
  discoverAgentCodeGitHubSkills: (input: string): Promise<AgentCodeInstalledSkillDiscoveryResult> =>
    ipcRenderer.invoke('agent-code-installed-skills:discover', input),
  installAgentCodeGitHubSkills: (
    request: InstallAgentCodeGitHubSkillsRequest,
  ): Promise<AgentCodeInstalledSkillsMutationResult> =>
    ipcRenderer.invoke('agent-code-installed-skills:install', request),
  setAgentCodeInstalledSkillEnabled: (
    request: SetAgentCodeInstalledSkillEnabledRequest,
  ): Promise<AgentCodeInstalledSkillsMutationResult> =>
    ipcRenderer.invoke('agent-code-installed-skills:set-enabled', request),
  setAgentCodeInstalledSkillProviders: (
    request: SetAgentCodeInstalledSkillProvidersRequest,
  ): Promise<AgentCodeInstalledSkillsMutationResult> =>
    ipcRenderer.invoke('agent-code-installed-skills:set-providers', request),
  checkAgentCodeInstalledSkillForUpdates: (
    skillId: string,
  ): Promise<AgentCodeInstalledSkillUpdateResult> =>
    ipcRenderer.invoke('agent-code-installed-skills:check-update', skillId),
  applyAgentCodeInstalledSkillUpdate: (
    request: ApplyAgentCodeInstalledSkillUpdateRequest,
  ): Promise<AgentCodeInstalledSkillsMutationResult> =>
    ipcRenderer.invoke('agent-code-installed-skills:apply-update', request),
  deleteAgentCodeInstalledSkill: (
    request: DeleteAgentCodeInstalledSkillRequest,
  ): Promise<AgentCodeInstalledSkillsMutationResult> =>
    ipcRenderer.invoke('agent-code-installed-skills:delete', request),
  revealAgentCodeInstalledSkillTarget: (
    skillId: string,
    targetId: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('agent-code-installed-skills:reveal-target', skillId, targetId),
  revealAgentCodeInstalledSkillSource: (
    skillId: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('agent-code-installed-skills:reveal-source', skillId),
  revealAgentCodeInstalledSkillsRecoveryFile: (): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('agent-code-installed-skills:reveal-recovery'),
  resetAgentCodeInstalledSkillsRecovery: (): Promise<AgentCodeInstalledSkillsMutationResult> =>
    ipcRenderer.invoke('agent-code-installed-skills:reset-recovery'),
}
