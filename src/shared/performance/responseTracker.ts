import type { OperationEnd } from './operationTimers.js'
import { OperationTimers } from './operationTimers.js'
import type { MonitorOutcome } from './monitorPolicy.js'

// First-output timing is a wait observation, not a CPU measurement or a claim
// of a network fault. Only semantic output events finish it; PTY echo, user
// transcript append and provider readiness cannot masquerade as a response.
export function isResponseOutput(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false
  return ['text_delta', 'thinking_delta', 'connector_text_delta', 'tool_input_delta', 'tool_input_finalized'].includes((event as { type?: string }).type ?? '')
}

type PendingResponse = { end: OperationEnd; at: number; operationId?: string; armed: boolean; outputAt: number | null }

/** Tracks submit → first semantic output per session.
 *
 * WHY timers can start unarmed: the clock must start at submit, but only the
 * provider's acceptance says whether this prompt starts a turn. A prompt that
 * Claude queues behind a running turn used to finish its timer on the RUNNING
 * turn's next delta, recording a fast "first output" that belonged to another
 * prompt. An unarmed timer remembers the first output it sees; acceptance then
 * either arms it (and credits that remembered output) or cancels it.
 *
 * The injected clock must be the same clock `OperationTimers` uses, because the
 * remembered output time is handed back to it as the span's end. */
export class ResponseTracker {
  private pending = new Map<string, PendingResponse>()
  // A renderer begin for the same submit can arrive after main already
  // finished or cancelled that operation. Without this bounded memory it would
  // start a fresh timer that the NEXT turn's output completes.
  private retired: string[] = []
  constructor(private timers: OperationTimers, private now: () => number = () => performance.now()) {}
  begin(sessionId: string, operationId?: string, armed = true): void {
    if (operationId && this.retired.includes(operationId)) return
    const current = this.pending.get(sessionId)
    if (current && current.operationId === operationId) {
      if (armed) this.arm(sessionId, operationId)
      return
    }
    this.cancel(sessionId)
    if (this.pending.size >= 2048) return
    this.pending.set(sessionId, {
      end: this.timers.begin('provider.first-output', sessionId, operationId), at: this.now(),
      ...(operationId ? { operationId } : {}), armed, outputAt: null,
    })
  }
  arm(sessionId: string, operationId?: string): void {
    const current = this.pending.get(sessionId)
    if (!current || current.operationId !== operationId || current.armed) return
    current.armed = true
    if (current.outputAt !== null) this.finish(sessionId, 'success', current.outputAt)
  }
  output(sessionId: string, event: unknown): void {
    if (!isResponseOutput(event)) return
    const current = this.pending.get(sessionId)
    if (!current) return
    if (current.armed) this.finish(sessionId, 'success')
    else current.outputAt ??= this.now()
  }
  cancel(sessionId: string): void { this.finish(sessionId, 'cancelled') }
  /** Cancel only the named submit. A settle message for an older submit must
   * never cancel the newer submit that already replaced it in this session. */
  cancelOperation(sessionId: string, operationId?: string): void {
    if (this.pending.get(sessionId)?.operationId === operationId) this.finish(sessionId, 'cancelled')
  }
  sweep(): void { for (const [id, entry] of this.pending) if (this.now() - entry.at >= 10 * 60_000) this.finish(id, 'timeout') }

  private finish(sessionId: string, outcome: MonitorOutcome, endedAt?: number): void {
    const current = this.pending.get(sessionId)
    if (!current) return
    this.pending.delete(sessionId)
    current.end(outcome, endedAt)
    if (current.operationId) {
      this.retired.push(current.operationId)
      if (this.retired.length > 64) this.retired.shift()
    }
  }
}
