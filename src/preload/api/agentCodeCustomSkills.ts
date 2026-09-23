import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'
import {
  MANAGED_SKILLS_UNAVAILABLE_CHANNEL,
  type ManagedSkillsUnavailableEvent,
} from '@shared/types/tldr.js'

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
  // #1133: an agent was launched without a product skill (TLDR/Goal) it asked
  // for, because the pre-spawn reconcile could not prepare it. It lives here
  // because TLDR and Goal ARE custom skills ("Managed by … MCP" rows), and this
  // module is where the renderer already talks to them.
  onManagedSkillsUnavailable: (cb: (event: ManagedSkillsUnavailableEvent) => void): Unsub =>
    subscribe(MANAGED_SKILLS_UNAVAILABLE_CHANNEL, cb),
}
