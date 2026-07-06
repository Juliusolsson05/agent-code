import type { StreamPhase } from '@renderer/workspace/workspaceState'
import { isAgentProviderKind } from '@shared/types/providerKind'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'

// Renamed from shouldClearIdleCodexQueuedMessages (2026-07-06): the
// predicate now covers every provider whose queued rows are LOCAL UI
// placeholders, which the `usesOptimisticUserEcho` capability is the
// authority for — codex AND opencode today. The old `provider ===
// 'codex'` literal meant opencode queued placeholders leaked forever:
// opencode gets the optimistic queue rows (usesOptimisticUserEcho:
// true) but was excluded from the only invariant allowed to clear them
// on idle.
export function shouldClearIdleQueuedMessages({
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
  // prompt row once the provider looks idle. The whole reason it is safe to
  // do that is the absence of any provider-owned queue authority for the
  // optimistic-echo providers — their queue rows are local UI placeholders,
  // not durable provider records (unlike Claude's `queue-operation`
  // transcript records). If a future protocol ever surfaces a real "you
  // still have N prompts queued server-side" signal, clearing on idle would
  // silently drop work the provider still intends to run. This flag is the
  // documented hook for that case: when the provider reports a pending
  // queue, we must NOT clear, no matter how idle the local lifecycle looks.
  // Today neither codex nor opencode emits such a signal, so every caller
  // passes the default (false). The capability gate below keeps this entire
  // mechanism scoped to local-placeholder queues; Claude's provider-owned
  // queue is never touched here.
  providerReportsPendingQueue?: boolean
}): boolean {
  // WHY this invariant is capability-gated instead of `provider === 'codex'`:
  // Claude has explicit `queue-operation` transcript records, so a
  // queued prompt item can represent provider-owned queue state that needs to
  // drain through dequeue/remove events. Codex and opencode queue rows are
  // local UI placeholders for prompts submitted while semantic output is
  // still live; they clear when the matching committed user row is ingested.
  // If that committed tail goes stale, the matching row may exist on disk /
  // server-side while the renderer never observes it, leaving a permanent
  // local queued prompt item after the provider is idle. Once such a
  // provider has no process, stream, or optimistic-awaiting signal, there
  // is no remaining provider queue authority that can justify keeping the
  // local row. `usesOptimisticUserEcho` is exactly the capability that
  // creates these local placeholder rows (see useComposerKeybinds), so it is
  // also the right authority for who may clear them — the two must stay in
  // lockstep or one provider ends up with rows nobody is allowed to remove
  // (the pre-fix opencode leak).
  const hasLocalPlaceholderQueue =
    provider !== undefined &&
    isAgentProviderKind(provider) &&
    getRendererProviderCapabilities(provider).usesOptimisticUserEcho
  return (
    hasLocalPlaceholderQueue &&
    queuedMessagesLength > 0 &&
    !processActive &&
    streamPhase === 'idle' &&
    !awaitingAssistant &&
    !providerReportsPendingQueue
  )
}
