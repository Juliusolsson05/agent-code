import type { OperationEnd } from './operationTimers.js'
import { OperationTimers } from './operationTimers.js'

// First-output timing is a wait observation, not a CPU measurement or a claim
// of a network fault. Only semantic output events finish it; PTY echo, user
// transcript append and provider readiness cannot masquerade as a response.
export function isResponseOutput(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false
  return ['text_delta', 'thinking_delta', 'connector_text_delta', 'tool_input_delta', 'tool_input_finalized'].includes((event as { type?: string }).type ?? '')
}
export class ResponseTracker {
  private pending = new Map<string, { end: OperationEnd; at: number }>()
  constructor(private timers: OperationTimers, private now: () => number = () => performance.now()) {}
  begin(sessionId: string, operationId?: string): void {
    this.cancel(sessionId)
    if (this.pending.size >= 2048) return
    this.pending.set(sessionId, { end: this.timers.begin('provider.first-output', sessionId, operationId), at: this.now() })
  }
  output(sessionId: string, event: unknown): void {
    if (!isResponseOutput(event)) return
    this.pending.get(sessionId)?.end()
    this.pending.delete(sessionId)
  }
  cancel(sessionId: string): void { this.pending.get(sessionId)?.end('cancelled'); this.pending.delete(sessionId) }
  sweep(): void { for (const [id, entry] of this.pending) if (this.now() - entry.at >= 10 * 60_000) { entry.end('timeout'); this.pending.delete(id) } }
}
