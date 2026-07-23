import { ipcRenderer } from 'electron'

import type {
  AgentCodeConventionsMutationResult,
  AgentCodeConventionsPreviewResult,
  AgentCodeConventionsSnapshot,
  ClearAgentCodeConventionsRequest,
  SaveAgentCodeConventionsRequest,
} from '@shared/types/agentCodeConventions.js'

export const agentCodeConventionsApi = {
  getAgentCodeConventions: (): Promise<AgentCodeConventionsSnapshot> =>
    ipcRenderer.invoke('agent-code-conventions:get'),
  auditAgentCodeConventions: (): Promise<AgentCodeConventionsSnapshot> =>
    ipcRenderer.invoke('agent-code-conventions:audit'),
  saveAgentCodeConventions: (
    request: SaveAgentCodeConventionsRequest,
  ): Promise<AgentCodeConventionsMutationResult> =>
    ipcRenderer.invoke('agent-code-conventions:save', request),
  disableAgentCodeConventions: (
    expectedRevision: number,
  ): Promise<AgentCodeConventionsMutationResult> =>
    ipcRenderer.invoke('agent-code-conventions:disable', expectedRevision),
  clearAgentCodeConventions: (
    request: ClearAgentCodeConventionsRequest,
  ): Promise<AgentCodeConventionsMutationResult> =>
    ipcRenderer.invoke('agent-code-conventions:clear', request),
  previewAgentCodeConventions: (markdown: string): Promise<AgentCodeConventionsPreviewResult> =>
    ipcRenderer.invoke('agent-code-conventions:preview', markdown),
  revealAgentCodeConventionsTarget: (
    targetId: string,
  ): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('agent-code-conventions:reveal-target', targetId),
  revealAgentCodeConventionsRecoveryFile: (): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('agent-code-conventions:reveal-recovery'),
  resetAgentCodeConventionsRecovery: (): Promise<AgentCodeConventionsMutationResult> =>
    ipcRenderer.invoke('agent-code-conventions:reset-recovery'),
}
