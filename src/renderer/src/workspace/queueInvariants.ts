import type { StreamPhase } from '@renderer/workspace/workspaceState'

export function shouldClearIdleCodexQueuedMessages({
  awaitingAssistant,
  processActive,
  provider,
  queuedMessagesLength,
  streamPhase,
}: {
  awaitingAssistant: boolean
  processActive: boolean
  provider: string | undefined
  queuedMessagesLength: number
  streamPhase: StreamPhase
}): boolean {
  // WHY this invariant is Codex-only:
  // Claude has explicit `queue-operation` transcript records, so a
  // queued strip can represent provider-owned queue state that needs to
  // drain through dequeue/remove events. Codex queue rows are local UI
  // placeholders for prompts submitted while semantic output is still
  // live; they clear when the matching rollout user row is ingested. If
  // the rollout tail goes stale, that matching row may exist on disk
  // while the renderer never observes it, leaving a permanent local
  // QueueStrip after the provider is idle. Once Codex has no process,
  // stream, or optimistic-awaiting signal, there is no remaining
  // provider queue authority that can justify keeping the local row.
  return (
    provider === 'codex' &&
    queuedMessagesLength > 0 &&
    !processActive &&
    streamPhase === 'idle' &&
    !awaitingAssistant
  )
}
