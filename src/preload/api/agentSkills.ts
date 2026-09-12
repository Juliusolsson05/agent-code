import { ipcRenderer } from 'electron'
import type { AgentSkillsRequest, AgentSkillsSnapshot } from '@shared/types/agentSkills.js'

export const agentSkillsApi = {
  listAgentSkills: (request: AgentSkillsRequest): Promise<AgentSkillsSnapshot> =>
    ipcRenderer.invoke('agent-skills:list', request),
}
