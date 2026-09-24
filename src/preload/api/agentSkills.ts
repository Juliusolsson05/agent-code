import { ipcRenderer } from 'electron'
import type {
  AgentSkillsRequest,
  AgentSkillsSnapshot,
  ExternalAgentSkillsSnapshot,
} from '@shared/types/agentSkills.js'

export const agentSkillsApi = {
  listAgentSkills: (request: AgentSkillsRequest): Promise<AgentSkillsSnapshot> =>
    ipcRenderer.invoke('agent-skills:list', request),
  /** Skills in the personal roots that Agent Code does not manage (#1161). */
  listExternalAgentSkills: (): Promise<ExternalAgentSkillsSnapshot> =>
    ipcRenderer.invoke('agent-skills:external'),
  revealExternalAgentSkill: (targetId: string, folder: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('agent-skills:reveal-external', targetId, folder),
}
