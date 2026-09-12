import { randomUUID } from 'node:crypto'
import {
  controlFailure, type ControlContext, type ControlRequest, type ControlResult,
  type RendererControlRequest, type RendererControlResponse,
} from '@control-sdk'

type Pending = {
  windowId: string
  generation: string
  resolve(result: ControlResult): void
  timer: ReturnType<typeof setTimeout>
}

// WHY no Electron singleton here: correlation/lifetime belongs to the bridge,
// while sender authentication belongs to the IPC adapter. Tests can exercise
// disappearing owners without booting providers or borrowing live workspaces.
export class ControlRendererBridge {
  private readonly pending = new Map<string, Pending>()
  constructor(
    private readonly send: (windowId: string, message: RendererControlRequest) => void,
    private readonly timeoutMs = 30_000,
  ) {}

  invoke(request: ControlRequest, context: ControlContext): Promise<ControlResult> {
    if (context.owner.kind !== 'window') return Promise.resolve(controlFailure('unavailable', 'A renderer owner is required'))
    const { windowId, generation } = context.owner
    // A separate bridge ID permits one outer operation to make several calls
    // (or concurrent observations) without collisions in the pending map.
    const requestId = randomUUID()
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(controlFailure('unavailable', 'Renderer did not acknowledge before the deadline', 'unknown'))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(requestId, { windowId, generation, resolve, timer })
      try {
        this.send(windowId, { request, context: { ...context, operationId: context.operationId ?? context.requestId, requestId } })
      } catch {
        this.finish(requestId, controlFailure('unavailable', 'Renderer transport closed', 'unknown'))
      }
    })
  }

  resolve(windowId: string, response: RendererControlResponse): boolean {
    const pending = this.pending.get(response.requestId)
    if (!pending || pending.windowId !== windowId || pending.generation !== response.generation) return false
    this.finish(response.requestId, response.result)
    return true
  }

  retire(windowId: string, generation: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.windowId === windowId && pending.generation === generation) {
        this.finish(id, controlFailure('stale_owner', 'Renderer registration ended during execution', 'unknown'))
      }
    }
  }

  private finish(id: string, result: ControlResult): void {
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    pending.resolve(result)
  }
}
