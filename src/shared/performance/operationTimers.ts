import type { MonitorOperation } from './monitorContracts.js'
import { isMonitorId } from './monitorContracts.js'
import type { MonitorOperationName, MonitorOutcome } from './monitorPolicy.js'

// `endedAt` exists for waits whose end is observed before it is known to
// count (see ResponseTracker): the caller passes the remembered clock value
// instead of the later moment it decided to finish.
export type OperationEnd = (outcome?: MonitorOutcome, endedAt?: number) => void
const noop: OperationEnd = () => {}

/** Pending spans retain only finite names, a clock and opaque correlation IDs.
 * The application owns the real async work. Diagnostics never hold its promise,
 * arguments, error or cancellation controller, and expiry cannot cancel it. */
export class OperationTimers {
  private pending = new Map<number, { name: MonitorOperationName; startedAt: number; sessionId?: string; operationId?: string }>()
  private sequence = 0
  dropped = 0
  constructor(private readonly emit: (record: MonitorOperation) => void, private readonly now: () => number = () => performance.now(), private readonly capacity = 2000, private readonly expiryMs = 10 * 60_000) {}
  get size(): number { return this.pending.size }
  begin(name: MonitorOperationName, sessionId?: string, operationId?: string): OperationEnd {
    if (this.pending.size >= this.capacity) { this.dropped++; return noop }
    const token = ++this.sequence
    this.pending.set(token, { name, startedAt: this.now(), ...(isMonitorId(sessionId) ? { sessionId } : {}), ...(isMonitorId(operationId) ? { operationId } : {}) })
    return (outcome = 'success', endedAt) => this.finish(token, outcome, endedAt)
  }
  observe(name: MonitorOperationName, durationMs: number, outcome: MonitorOutcome = 'success'): void {
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 24 * 60 * 60_000) return
    try { this.emit({ kind: 'operation', name, durationMs, outcome }) } catch { this.dropped++ }
  }
  sweep(): void {
    const now = this.now()
    for (const [token, entry] of this.pending) if (now - entry.startedAt >= this.expiryMs) this.finish(token, 'timeout')
  }
  private finish(token: number, outcome: MonitorOutcome, endedAt?: number): void {
    const entry = this.pending.get(token)
    if (!entry) return
    this.pending.delete(token)
    const end = typeof endedAt === 'number' && Number.isFinite(endedAt) ? endedAt : this.now()
    const durationMs = Math.max(0, Math.min(24 * 60 * 60_000, end - entry.startedAt))
    try { this.emit({ kind: 'operation', name: entry.name, durationMs, outcome, ...(entry.sessionId ? { sessionId: entry.sessionId } : {}), ...(entry.operationId ? { operationId: entry.operationId } : {}) }) }
    catch { this.dropped++ /* A diagnostic sink cannot alter application outcomes. */ }
  }
}

/** Existing legacy spans identify real boundaries. Only this exact lookup can
 * promote one into baseline monitoring: no prefix matching or metadata copies. */
export const LEGACY_MONITOR_OPERATIONS: Readonly<Record<string, MonitorOperationName | undefined>> = {
  'worktreeActivity.refresh': 'worktree.refresh',
  'historyLoader.loadInitialChunk': 'transcript.read',
  'historyLoader.loadOlderChunk': 'transcript.read',
  'workspace.ipc.semantic.fold': 'transcript.fold',
  'workspace.ipc.jsonl.bulk': 'transcript.fold',
}
