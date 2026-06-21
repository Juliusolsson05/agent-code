import type { StreamPhase } from '@renderer/workspace/workspaceState'

export function shouldClearIdleCodexQueuedMessages({
  awaitingAssistant,
  processActive,
  provider,
  queuedMessagesLength,
  streamPhase,
  providerReportsPendingQueue = false,
}: {
  awaitingAssistant: boolean
  processActive: boolean
  provider: string | undefined
  queuedMessagesLength: number
  streamPhase: StreamPhase
  // WHY this param exists (and defaults false): this predicate is the
  // authority that lets the lifecycle reconciler DELETE a local queued
  // prompt row once Codex looks idle. The whole reason it is safe to do
  // that is the absence of any provider-owned queue authority for Codex —
  // Codex queue rows are local UI placeholders, not durable provider
  // records (unlike Claude's `queue-operation` transcript records). If a
  // future Codex protocol ever surfaces a real "you still have N prompts
  // queued server-side" signal, clearing on idle would silently drop work
  // the provider still intends to run. This flag is the documented hook
  // for that case: when the provider reports a pending queue, we must NOT
  // clear, no matter how idle the local lifecycle looks. Today Codex emits
  // no such signal, so every caller passes the default (false). The
  // `provider === 'codex'` clause below keeps this entire mechanism
  // Codex-scoped; Claude's provider-owned queue is never touched here.
  providerReportsPendingQueue?: boolean
}): boolean {
  // WHY this invariant is Codex-only:
  // Claude has explicit `queue-operation` transcript records, so a
  // queued prompt item can represent provider-owned queue state that needs to
  // drain through dequeue/remove events. Codex queue rows are local UI
  // placeholders for prompts submitted while semantic output is still
  // live; they clear when the matching rollout user row is ingested. If
  // the rollout tail goes stale, that matching row may exist on disk
  // while the renderer never observes it, leaving a permanent local
  // queued prompt item after the provider is idle. Once Codex has no process,
  // stream, or optimistic-awaiting signal, there is no remaining
  // provider queue authority that can justify keeping the local row.
  return (
    provider === 'codex' &&
    queuedMessagesLength > 0 &&
    !processActive &&
    streamPhase === 'idle' &&
    !awaitingAssistant &&
    !providerReportsPendingQueue
  )
}
