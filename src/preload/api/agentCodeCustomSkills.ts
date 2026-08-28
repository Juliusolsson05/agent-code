import { ipcRenderer } from 'electron'

import type {
  AgentCodeCustomSkillDraft,
  AgentCodeCustomSkillPreviewResult,
  AgentCodeCustomSkillsMutationResult,
  AgentCodeCustomSkillsSnapshot,
  CreateAgentCodeCustomSkillRequest,
  DeleteAgentCodeCustomSkillRequest,
  SetAgentCodeCustomSkillEnabledRequest,
  UpdateAgentCodeCustomSkillRequest,
} from '@shared/types/agentCodeCustomSkills.js'

export const agentCodeCustomSkillsApi = {
  getAgentCodeCustomSkills: (): Promise<AgentCodeCustomSkillsSnapshot> =>
    ipcRenderer.invoke('agent-code-custom-skills:get'),
  auditAgentCodeCustomSkills: (): Promise<AgentCodeCustomSkillsSnapshot> =>
    ipcRenderer.invoke('agent-code-custom-skills:audit'),
  createAgentCodeCustomSkill: (
    request: CreateAgentCodeCustomSkillRequest,
  ): Promise<AgentCodeCustomSkillsMutationResult> =>
    ipcRenderer.invoke('agent-code-custom-skills:create', request),
  updateAgentCodeCustomSkill: (
    request: UpdateAgentCodeCustomSkillRequest,
  ): Promise<AgentCodeCustomSkillsMutationResult> =>
    ipcRenderer.invoke('agent-code-custom-skills:update', request),
  setAgentCodeCustomSkillEnabled: (
    request: SetAgentCodeCustomSkillEnabledRequest,
  ): Promise<AgentCodeCustomSkillsMutationResult> =>
    ipcRenderer.invoke('agent-code-custom-skills:set-enabled', request),
  deleteAgentCodeCustomSkill: (
    request: DeleteAgentCodeCustomSkillRequest,
  ): Promise<AgentCodeCustomSkillsMutationResult> =>
    ipcRenderer.invoke('agent-code-custom-skills:delete', request),
  previewAgentCodeCustomSkill: (
    draft: AgentCodeCustomSkillDraft,
  ): Promise<AgentCodeCustomSkillPreviewResult> =>
    ipcRenderer.invoke('agent-code-custom-skills:preview', draft),
  revealAgentCodeCustomSkillTarget: (
    skillId: string,
    targetId: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('agent-code-custom-skills:reveal-target', skillId, targetId),
  revealAgentCodeCustomSkillsRecoveryFile: (): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('agent-code-custom-skills:reveal-recovery'),
  resetAgentCodeCustomSkillsRecovery: (): Promise<AgentCodeCustomSkillsMutationResult> =>
    ipcRenderer.invoke('agent-code-custom-skills:reset-recovery'),
}
