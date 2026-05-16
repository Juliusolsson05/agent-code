import { randomUUID } from 'node:crypto'

import { sendToMainWindow } from '@main/window/mainWindow.js'
import type {
  OrchestrationAgentKind,
  OrchestrationAgentRecord,
  OrchestrationRendererRequest,
  OrchestrationRendererResponse,
} from '@mcp/shared/orchestrationTypes.js'
import type { BuiltInMcpDomain } from '@mcp/shared/types.js'

type PendingRequest = {
  resolve: (response: OrchestrationRendererResponse) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class OrchestrationBridge {
  private readonly pending = new Map<string, PendingRequest>()

  async createAgent(params: {
    parentSessionId: string
    kind: OrchestrationAgentKind
    cwd?: string
    title?: string
    role?: string
    runId?: string
    builtInMcpDomains?: BuiltInMcpDomain[]
  }): Promise<OrchestrationAgentRecord> {
    const response = await this.request({
      requestId: randomUUID(),
      type: 'create-agent',
      ...params,
    })
    if (!response.ok) throw new Error(response.message)
    if (response.type !== 'create-agent') {
      throw new Error(`Unexpected orchestration response: ${response.type}`)
    }
    return response.agent
  }

  async listAgents(params: {
    parentSessionId: string
    runId?: string
  }): Promise<OrchestrationAgentRecord[]> {
    const response = await this.request({
      requestId: randomUUID(),
      type: 'list-agents',
      ...params,
    })
    if (!response.ok) throw new Error(response.message)
    if (response.type !== 'list-agents') {
      throw new Error(`Unexpected orchestration response: ${response.type}`)
    }
    return response.agents
  }

  resolve(response: OrchestrationRendererResponse): void {
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(response.requestId)
    pending.resolve(response)
  }

  private async request(
    request: OrchestrationRendererRequest,
  ): Promise<OrchestrationRendererResponse> {
    // WHY orchestration uses a renderer request bridge instead of creating
    // child sessions directly in main:
    //
    // SessionManager can spawn provider processes, but it does not own the
    // workspace model: detached Dispatch placement, parent project affinity,
    // titles, persisted metadata, and future multi-window behavior all live in
    // the renderer workspace store. An orchestration agent must create a REAL
    // Agent Code agent that the user can see and manage, so main asks the
    // renderer to perform the workspace mutation and only handles MCP/PTY work
    // around it.
    return await new Promise<OrchestrationRendererResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId)
        reject(new Error('Timed out waiting for renderer orchestration response'))
      }, 30_000)
      this.pending.set(request.requestId, { resolve, reject, timer })
      sendToMainWindow('orchestration:request', request)
    })
  }
}
