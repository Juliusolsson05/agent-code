import { ipcRenderer } from 'electron'
import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'
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
  /** An agent proposed or withdrew a skill through the `skills` MCP domain (#1161). */
  onManagedSkillsAgentChange: (cb: (event: { message: string }) => void): Unsub =>
    subscribe('managed-skills:agent-change', cb),
  revealExternalAgentSkill: (targetId: string, folder: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('agent-skills:reveal-external', targetId, folder),
}
