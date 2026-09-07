import { ipcRenderer } from 'electron'

// WHY this is not a method on workspaceApi: workspaceApi is the bridge to the
// window-owned workspace.json byte mover, and the decomposition keeps name
// allocation isolated from that persistence on purpose. Grouping them would
// invite exactly the coupling the isolation rule forbids — someone would
// eventually save names "while they are already writing the workspace".
export const agentNamesApi = {
  /**
   * Reserve (or re-read) a name for each durable naming identity.
   *
   * Allocation happens in main and is committed to disk before this resolves,
   * so a returned name is already permanent. Identities are opaque to main:
   * the renderer decides which logical agent an identity belongs to.
   *
   * On failure the caller must show no name at all. There is no client-side
   * fallback: a fabricated name is worse than an absent one, because an
   * operator would speak it and reach nothing.
   */
  resolveAgentNames: (identities: string[]): Promise<Record<string, string>> =>
    ipcRenderer.invoke('agent-names:resolve', identities),
}
