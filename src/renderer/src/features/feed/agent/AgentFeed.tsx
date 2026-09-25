import { Feed } from '@renderer/features/feed/ui/Feed'
import type { FeedProps } from '@renderer/features/feed/ui/Feed'
import type { AgentProviderKind } from '@shared/types/providerKind'

import type { AgentFeedModel, AgentFeedRuntime } from './useAgentFeedModel'

// AgentFeed — the ONE place a runtime becomes Feed props (#1177).
//
// The desktop pane (TileLeaf) and the phone (SessionView) both mount this.
// Before, each passed ~25 props to Feed by hand and the phone's copy was a
// documented "mirror" of TileLeaf's that had drifted (raw entries instead of
// the merged fallback, a different askUserQuestion sentinel, stale line
// references). Now a prop Feed grows is wired here once.
//
// What a surface still passes is CHROME: behaviour that only one surface
// has — tail mode and pickers (desktop keyboard), scroll telemetry for the
// desktop's scroll indicator, usage-limit actions, render-debug logging. A
// surface without them simply omits them, and Feed's defaults are the
// no-chrome behaviour.

export type AgentFeedChromeProps = Pick<
  FeedProps,
  | 'usageLimitActions'
  | 'workspaceRoot'
  | 'tailMode'
  | 'pickerSelectedUuid'
  | 'codeBlockSelectedId'
  | 'onScrollInfo'
  | 'onUserEngagement'
  | 'scrollToLatestRequest'
  | 'onDebugLog'
>

export function AgentFeed({
  sessionId,
  provider,
  runtime,
  model,
  onLoadOlderHistory,
  ...chrome
}: {
  sessionId: string
  provider: AgentProviderKind
  runtime: AgentFeedRuntime
  model: AgentFeedModel
  onLoadOlderHistory: () => Promise<void>
} & AgentFeedChromeProps) {
  return (
    <Feed
      {...chrome}
      sessionId={sessionId}
      provider={provider}
      // The ownership ledger decides every row since the Stage 3 cutover;
      // Feed paints what it returns. The resolver is shared so mounted Block
      // rows reuse the ledger's operation decision instead of re-parsing.
      renderItemsOverride={model.ledgerFeedPlan.items}
      committedOperationDecisionOverride={model.ledgerFeedPlan.resolveOperation}
      // Committed transcript + (rare) orphan-ghost fallback. The layered
      // predicate in selectMergedEntries renders a ghost only when JSONL has
      // stalled past the proxy AND the ghost is not sidecar-shaped, and it
      // suppresses ghosts for turn ids the semantic surfaces already own, so
      // the two never double-render. See docs/design/ghost-system.md.
      entries={model.mergedEntries}
      // Live text renders ONLY from the semantic channel. Feed never parses
      // the TUI buffer: screen-derived text does not reach runtime.semantic
      // at all since the 2026-04-18 headless redesign (#855 was Reader
      // filling it from the screen).
      //
      // Adapter-derived stream phase drives the in-feed WorkIndicator; the
      // renderer never re-derives it (2026-04-18-thinking-phase-in-headless.md).
      streamPhase={runtime.streamPhase}
      streamPhasePendingToolName={runtime.streamPhasePendingToolName}
      streamPhasePendingToolUseId={runtime.streamPhasePendingToolUseId}
      turnStartedAt={runtime.turnStartedAt}
      // Live-turn ownership: the semantic turn renders the current turn end to
      // end. Completed semantic history is passed too because MCP/Codex tool
      // execution can advance through several Responses turns before JSONL
      // commits their rows; without this bounded bridge, archiving the current
      // turn made the visible feed shrink until the durable transcript caught
      // up — the "conversation clears while the agent is working" failure.
      semanticHistory={runtime.semantic.history}
      semanticTurn={runtime.semantic.currentTurn}
      hasOlderHistory={runtime.hasOlderHistory}
      loadingOlderHistory={runtime.loadingOlderHistory}
      onLoadOlderHistory={onLoadOlderHistory}
      // While a bootstrap replay applies, Feed suspends per-append
      // auto-scroll and the lazy-mount cascade; the indices spare it a
      // rebuild on every append.
      bootstrapping={runtime.bootstrapping}
      toolUseIndex={runtime.toolUseIndex}
      toolResultIndex={runtime.toolResultIndex}
      toolIndexVersion={runtime.toolIndexVersion}
      subAgents={runtime.subAgents ?? undefined}
      askUserQuestionState={model.askUserQuestionState}
    />
  )
}
