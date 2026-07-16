import {
  taskNotificationFromEntry,
  type TaskNotification,
} from '@renderer/session-runtime/taskNotification'
import { TaskNotificationsContext } from '@renderer/features/feed/context'
import {
  memo,
  useMemo,
  useRef,
} from 'react'

import {
  type Entry,
} from '@shared/types/transcript'

import type {
  SemanticLiveTurn,
  StreamPhase,
} from '@renderer/session-runtime/state'
import { toolHintFromTurn } from '@renderer/features/feed/workIndicatorHints'
import {
  ToolResultIndexContext,
  CodeRenderContext,
  SubAgentsContext,
  AskUserQuestionConditionContext,
} from '@renderer/features/feed/context'
import {
  type AgentProvider,
  type ScrollInfo,
  type DebugVisibleRow,
} from '@renderer/features/feed/types'
import {
  buildToolUseIndex,
  buildToolResultIndex,
} from '@renderer/features/feed/lib/helpers'
import {
  feedRenderModelFromItems,
  type FeedRenderItem,
} from '@renderer/features/feed/model/renderModel'
import { semanticTurnScrollSignal } from '@renderer/session-runtime/semantic/helpers'
import { useFeedDebugEmission } from '@renderer/features/feed/ui/hooks/useFeedDebugEmission'
import { usePickerAutoScroll } from '@renderer/features/feed/ui/hooks/usePickerAutoScroll'
import { useScrollFeedBehaviors } from '@renderer/features/feed/ui/hooks/useScrollFeedBehaviors'
import {
  EAGER_TAIL,
  LazyEntry,
} from '@renderer/features/feed/ui/rows'
import { projectFeedPresentation } from '@renderer/features/feed/presentation/projectFeed'
import { PresentationRow } from '@renderer/features/feed/ui/operations/PresentationRow'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { SubAgentState } from '@renderer/session-runtime/state'
import type { ClaudeAskUserQuestionState } from '@shared/types/providerConditions'

// Re-export — many external callers import these types from Feed
// directly rather than reaching into ../types/../context. Keep the
// alias stable until the sweep is over.
export type { AgentProvider, ScrollInfo } from '@renderer/features/feed/types'
// NOTE: the `CodeRenderContext` re-export was removed (feed audit Finding 8).
// The canonical home is `@renderer/features/feed/context`, shared by feed,
// reader, preview, and provider rows; re-exporting it from the feed CONTAINER
// module coupled provider rows to Feed.tsx (which itself imports provider row
// dispatchers) and created a needless import cycle risk. All consumers now
// import it directly from `context`.

// -----------------------------------------------------------------------------
// Feed — Claude Code TUI-style inline rendering.
//
// Design rules (discussed with the user):
//   1. No bubbles. No cards. No role labels. Messages flow inline like a
//      terminal session — each block gets a single-char marker in the
//      accent color, content wraps with a hanging indent beside it.
//   2. User text → `❯`. Assistant text → `⏺`. Tool results and CC's
//      sub-items → `⎿`. Same markers CC's own TUI uses.
//   3. System entries (permission-mode, file-history-snapshot, hook
//      attachments) are hidden by default and only render when the
//      user opts in via settings.
//   4. Sharp everything — no border-radius, no shadows, no pills. The
//      visual rhythm comes entirely from the marker + hanging indent.
//
// Hanging indent implementation:
//   <div flex gap-3>
//     <span w-3 text-accent>⏺</span>
//     <div flex-1 min-w-0>...content wraps here...</div>
//   </div>
//
// Because the marker column is a fixed width and the content column is
// flex-1, long lines wrap under the content column only — they don't
// creep back under the marker. Standard hanging-indent pattern.
// -----------------------------------------------------------------------------

// Session-wide result/subagent/question/code metadata lives in context.tsx.
// Provider identity, source pairing, and operation family are structural fields
// on the pure presentation projection; putting those back in context would
// recreate the implicit two-plane dispatch this rewrite removed.

// MarkdownPre / MarkdownCode / MARKDOWN_COMPONENTS moved to
// ./markdown/MarkdownComponents.tsx. TextProse and StreamingProse
// moved to ./markdown/Prose.tsx. Both are re-exported from
// ./markdown/index.ts — see those for the full rationale on why
// we override react-markdown's default <pre>/<code> renderers and
// why two remark plugin sets exist.
//
// buildToolUseIndex / buildToolResultIndex / extractToolCommand /
// toolResultText moved to ../lib/helpers.ts. AgentProvider and
// ScrollInfo types moved to ../types.ts; re-exported at the top of
// this file.

type Props = {
  /** Session identity — used as the key for per-session scroll
   *  position persistence across Feed unmount/remount (tab switches).
   *  See ui/hooks/useScrollFeedBehaviors.ts (`scrollPositions`). */
  sessionId: string
  /** Which provider's row renderers to use. Default 'claude'. */
  provider?: AgentProvider
  entries: Entry[]
  /**
   * The ownership-ledger pipeline's pre-decided, pre-ordered item list — the
   * ONLY source of Feed's rows since the Stage 3 cutover. The ledger made
   * every visibility/ownership/order decision upstream (desktop: TileLeaf via
   * useLedgerFeedItems; phone: remote SessionView via the same hook); Feed
   * just paints. Kept nullable only so a caller mid-migration can pass null
   * for an empty feed — there is no longer a legacy fallback path behind it.
   */
  renderItemsOverride?: FeedRenderItem[] | null
  // NOTE: the `activityStatus` prop was removed (feed audit Deletion Candidate
  // 1). It was declared and destructured but never read inside Feed — once
  // `streamPhase` took over the in-feed WorkIndicator, the spinner verb text
  // stopped driving any rendering here. The runtime field still lives on
  // SessionRuntime for DebugPanel/status surfaces; only the dead Feed prop and
  // its TileLeaf pass-through are gone.
  /** Adapter-derived stream phase — drives the in-feed WorkIndicator.
   *  See SessionRuntime.streamPhase for the contract. */
  streamPhase?: StreamPhase
  streamPhasePendingToolName?: string | null
  streamPhasePendingToolUseId?: string | null
  turnStartedAt?: number | null
  tailMode?: boolean
  /**
   * UUID of the assistant entry currently highlighted by the
   * "Copy Assistant Message" picker. Null when the picker is not
   * active. Drives a 2px accent outline on the matching row and
   * auto-scrolls into view when the value changes.
   */
  pickerSelectedUuid?: string | null
  /**
   * Instance id (`data-code-block-id`) of the code block currently
   * highlighted by the "Copy Code Block" picker. Null when that
   * picker is not active. Drives an accent outline on the matching
   * CodeBlock and auto-scrolls it into view when the value changes.
   */
  codeBlockSelectedId?: string | null
  workspaceRoot?: string | null
  /** Called on every scroll tick with the current position. */
  onScrollInfo?: (info: ScrollInfo) => void
  /** User-originated engagement with the feed surface. Programmatic
   *  auto-scroll must not call this; unread badges should clear only
   *  when the user actually touches the session. */
  onUserEngagement?: () => void
  hasOlderHistory?: boolean
  loadingOlderHistory?: boolean
  onLoadOlderHistory?: () => Promise<void>
  semanticHistory?: SemanticLiveTurn[]
  semanticTurn?: SemanticLiveTurn | null
  /** True while the owning session is replaying a bulk bootstrap
   *  burst. Feed uses it to suspend auto-scroll pinning and the
   *  IntersectionObserver-driven lazy mount, avoiding the layout
   *  cascade that otherwise makes resume feel like "scrolling
   *  through the whole conversation." */
  bootstrapping?: boolean
  scrollToLatestRequest?: number
  /** Incremental tool indices maintained by workspaceStore. Feed
   *  used to rebuild these via `useMemo([entries])` per render, which
   *  was O(N) per append and O(N²) per bootstrap burst. Passed in
   *  now from the runtime — the store grows them at ingest time. */
  toolUseIndex?: Map<string, ToolUseBlock>
  toolResultIndex?: Map<string, ToolResultBlock>
  /** Monotonic invalidation token for the two maps above (feed audit Finding 1).
   *  The runtime mutates the maps in place and keeps a STABLE reference, so the
   *  bare map identity can never tell React context consumers that a cross-entry
   *  tool_use↔tool_result pairing changed. The runtime bumps this whenever a
   *  pairing actually moves; Feed clones the map (cheap, only on bump) so the
   *  context value identity changes and memoized rows — most visibly a
   *  GitCardRow waiting on its paired result — repaint. Absent for preview
   *  surfaces that pass no runtime maps (they rebuild from `entries`). */
  toolIndexVersion?: number
  /** Subagent fleet for this session, keyed by parent `Agent` tool_use id.
   *  Threaded from runtime.subAgents and provided to rows via
   *  SubAgentsContext so the `Agent` card can render live status + drill-in. */
  subAgents?: Record<string, SubAgentState>
  /** Live AUQ screen condition, used only to gate clickability in the inline
   *  semantic row. Undefined means no snapshot yet; null means latest snapshot
   *  positively lacks the picker. Rendering still gates on the transcript block. */
  askUserQuestionState?: ClaudeAskUserQuestionState | null
  onDebugLog?: (entry: {
    layer: 'RENDER'
    kind: string
    summary: string
    data?: unknown
  }) => void
}

// VisibleDecision + DebugVisibleRow moved to ../types.ts.
// debugKeyForEntry + debugLabelForEntry moved to ../lib/helpers.ts.

// 2026-04-20: shouldSuppressSemanticTurnForCommittedTail and its two
// helpers (textFromConversationEntry, normalizeRenderableText) were
// deleted here. They were a narrow guardrail for one proven duplicate
// class on Codex: committed assistant entry + rollout-sourced live
// semantic turn painting the same sentence twice during the gap
// between rollout publishing `turn.text` and committed sealing the
// live owner.
//
// That duplicate class is now prevented at its source. The ghost
// reducer (`reconcileUpstream` in src/renderer/src/session-runtime/ghosts.ts)
// supersedes Codex text ghosts by rollout response id once the
// rollout mapper stamps `codexTurnId` on committed entries
// (src/renderer/src/workspace/workspaceStore.ts::codexTurnIdFromRollout
// + stampCodexTurnId). The live view and the merged feed are split
// by turn ownership (src/renderer/src/session-runtime/mergedEntries.ts), so
// there is no longer any path by which the same assistant text can
// reach both surfaces at once.
//
// See docs/superpowers/plans/2026-04-20-rendering-fixes.md Task 6.

// ScrollPosition type + scrollPositions map moved to ../scroll.ts
// and ../types.ts respectively — see those files for the "why persist
// scroll state outside the component tree" rationale.

// -----------------------------------------------------------------------------
// Memoization strategy — the whole reason this file is fast enough to type in
// -----------------------------------------------------------------------------
//
// Parsing markdown through unified (remark-parse → remark-gfm → rehype-
// highlight → highlight.js) is EXPENSIVE. A single assistant message with
// a handful of code blocks easily takes 5-15ms per ReactMarkdown call,
// and a scrolled-back feed can contain dozens of them. Without memoization,
// every keystroke in the composer input (which is a sibling component
// living inside the same TileLeaf) triggers a TileLeaf re-render, which
// re-renders <Feed>, which re-parses every single markdown block from
// scratch. That's 100ms+ of blocking work between the browser input event
// and the next paint — the input literally cannot update until the
// markdown finishes, and typing becomes unusable.
//
// The fix is a two-layer memo:
//
//   1. `Feed` itself is memoized. When the parent re-renders for a reason
//      unrelated to feed content (user typing, focus toggle, split resize,
//      picker visibility change), Feed sees the same committed-entry
//      and semantic-turn references, and React.memo's default shallow
//      compare bails the entire subtree out. Zero markdown work happens.
//
//   2. Expensive leaves (`TextProse`, artifact bodies, code surfaces) remain
//      memoized, and PresentationRow uses a semantic comparator rather than
//      trusting the projector to preserve object identity. The projector is a
//      pure derivation, so it intentionally returns fresh VMs; comparing their
//      stable source evidence keeps old committed rows cold while one live
//      operation advances. This matters because the feed can contain hundreds
//      of restored rows beside one token-level stream.
//
// TextProse/StreamingProse are the hottest leaf; memoizing them by the
// `text` string is the single biggest win because ReactMarkdown itself
// has no memo and re-parses on every call.
//
// Live semantic evidence remains separate until the frozen ownership layer
// hands it to the presentation projector. Only the advancing projected node
// should invalidate; committed siblings must not inherit stream cadence.

export const Feed = memo(FeedImpl)

function FeedImpl({
  sessionId,
  provider = 'claude',
  entries,
  renderItemsOverride = null,
  streamPhase = 'idle',
  streamPhasePendingToolName = null,
  streamPhasePendingToolUseId = null,
  turnStartedAt = null,
  tailMode = false,
  pickerSelectedUuid = null,
  codeBlockSelectedId = null,
  workspaceRoot = null,
  onScrollInfo,
  onUserEngagement,
  hasOlderHistory = false,
  loadingOlderHistory = false,
  onLoadOlderHistory,
  semanticHistory = [],
  semanticTurn = null,
  bootstrapping = false,
  scrollToLatestRequest = 0,
  toolUseIndex: toolUseIndexProp,
  toolResultIndex: toolResultIndexProp,
  toolIndexVersion = 0,
  subAgents = {},
  askUserQuestionState,
  onDebugLog,
}: Props) {
  // Scroll container owned by Feed itself — not by TileLeaf — so the
  // sticky-bottom logic can own its own scroll listener without
  // reaching up the tree. TileLeaf's wrapper is just a flex cell and
  // no longer sets overflow-auto; see TileLeaf.tsx for the pair.
  //
  // The scarred scroll/picker behaviors (sticky-bottom follow, mount
  // restore, older-history load, bootstrap pin-once, scroll-to-latest,
  // both picker tweens) are PORTED VERBATIM into ui/hooks/ — see
  // useScrollFeedBehaviors.ts and usePickerAutoScroll.ts for every
  // original WHY comment. Feed owns only the refs the JSX needs.
  const scrollerRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  // Cheap fingerprints of the current semantic turn and bounded
  // semantic history so the sticky-bottom effect re-runs when semantic
  // deltas land, not only when committed entries append (feed audit
  // Finding 2 — per-block growth folded in via semanticTurnScrollSignal).
  const semanticTurnSignal = semanticTurn ? semanticTurnScrollSignal(semanticTurn) : ''
  const semanticHistorySignal = semanticHistory
    .map(semanticTurnScrollSignal)
    .join('|')

  const { cancelTween } = usePickerAutoScroll({
    scrollerRef,
    pickerSelectedUuid,
    codeBlockSelectedId,
  })
  useScrollFeedBehaviors({
    scrollerRef,
    sessionId,
    tailMode,
    bootstrapping,
    entriesLength: entries.length,
    semanticTurnSignal,
    semanticHistorySignal,
    hasOlderHistory,
    loadingOlderHistory,
    onLoadOlderHistory,
    onScrollInfo,
    scrollToLatestRequest,
    cancelPickerTween: cancelTween,
  })

  // Index EVERY tool_use block (not just the visible set) so tool_result
  // lookups still resolve even when some synthetic entries have been
  // filtered out. The index is cheap to
  // build (single pass) and the resulting Map is handed to result rows
  // via context.
  // Incremental indices live on the runtime and grow at entry-ingest time.
  //
  // WHY this is now a clone-on-version-bump and not a bare passthrough (feed
  // audit Finding 1): the runtime mutates these maps IN PLACE behind a stable
  // reference. Returning that reference straight through means the context
  // Provider value identity never changes when only a cross-entry pairing moves
  // (a tool_result landing in a later entry for a tool_use row mounted earlier),
  // so the presentation useMemo would otherwise keep a stale OperationVM.
  // Cloning into a fresh Map invalidates the projector and the one durable
  // TaskSubagent context consumer. The clone is O(N) but the dependency is
  // `toolIndexVersion` (bumped only on a REAL map change), NOT `entries`, so it
  // runs once per actual tool change — not once per append. That preserves the
  // bootstrap-burst performance win this incremental index was built for.
  //
  // The fallback path (preview / no runtime maps) rebuilds from `entries` and is
  // isolated below so the live path never depends on `entries`.
  const fallbackToolUseIndex = useMemo(
    () => (toolUseIndexProp ? null : buildToolUseIndex(entries)),
    [toolUseIndexProp, entries],
  )
  const fallbackToolResultIndex = useMemo(
    () => (toolResultIndexProp ? null : buildToolResultIndex(entries)),
    [toolResultIndexProp, entries],
  )
  const toolUseIndex = useMemo(
    () => (toolUseIndexProp ? new Map(toolUseIndexProp) : fallbackToolUseIndex!),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toolIndexVersion is the
    // intentional invalidation token for the in-place-mutated prop map.
    [toolUseIndexProp, toolIndexVersion, fallbackToolUseIndex],
  )
  const toolResultIndex = useMemo(
    () =>
      toolResultIndexProp ? new Map(toolResultIndexProp) : fallbackToolResultIndex!,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above.
    [toolResultIndexProp, toolIndexVersion, fallbackToolResultIndex],
  )

  // P2b: toolUseId → parsed task-notification. Entries-only memo (same
  // cadence as the committed projection): notifications are committed
  // rows, so live semantic ticks never rebuild this. TaskSubagentRow
  // treats a notification as its top status/result evidence; renderModel
  // uses the same parse to skip joined notification entries pre-LazyEntry.
  const taskNotifications = useMemo(() => {
    const out = new Map<string, TaskNotification>()
    for (const entry of entries) {
      const n = taskNotificationFromEntry(entry)
      if (n?.toolUseId) out.set(n.toolUseId, n)
    }
    return out
  }, [entries])

  // #491: `committedProjection` (deriveFeedCommittedProjection) is deleted — it
  // existed ONLY to feed SemanticStreamingTurn's committedAssistantText for its
  // in-component dedup. The ledger now owns that suppression, and
  // SemanticStreamingTurn is gone, so Feed no longer derives any committed
  // projection of its own.

  // Stage 3 cutover (2026-07): the ownership ledger is the SOLE decision core.
  // Feed no longer derives its own render model — both the desktop (TileLeaf)
  // and the phone (remote SessionView) hand it the ledger's pre-decided,
  // pre-ordered items via renderItemsOverride, and `feedRenderModelFromItems`
  // only attaches the two debug side-products. The old in-Feed
  // deriveFeedRenderModel branch (the second decision-maker this rewrite
  // exists to kill) and its perf metric are deleted. `?? []` is pure
  // defense — both live callers always pass an array.
  const renderModel = useMemo(
    () => feedRenderModelFromItems(renderItemsOverride ?? [], provider),
    [renderItemsOverride, provider],
  )

  const visibleDecisions = renderModel.visibleDecisions
  const renderItems = renderModel.items
  // The ledger above remains the sole owner/visibility/order authority. This
  // second pure projection is intentionally presentation-only: it pairs the
  // already-approved live/committed evidence into stable user-intent rows and
  // produces receipts for debug accountability. It owns no store and performs
  // no IO, so a saved FeedRenderItem fixture reproduces the exact UI model.
  const presentation = useMemo(
    () => projectFeedPresentation({
      items: renderItems,
      provider,
      toolUseIndex,
      toolResultIndex,
    }),
    [provider, renderItems, toolResultIndex, toolUseIndex],
  )
  const renderedRows = useMemo<DebugVisibleRow[]>(
    () => presentation.nodes.map(node => {
      const slot: DebugVisibleRow['slot'] =
        node.kind === 'system' && node.system.type === 'work'
          ? 'work'
          : node.kind === 'system' && node.system.type === 'empty'
            ? 'empty'
            : node.entryOrdinal !== null
              ? 'entry'
              : 'semantic'
      const label = (() => {
        switch (node.kind) {
          case 'operation':
            return `${node.operation.family} · ${node.operation.toolName} · ${node.operation.lifecycle}`
          case 'operation-group':
            return `collaboration · ${node.operationIds.length} agents`
          case 'message':
            return `${node.role} message${node.streaming ? ' (streaming)' : ''}`
          case 'thinking':
            return node.redacted ? 'thinking (redacted)' : `thinking${node.streaming ? ' (streaming)' : ''}`
          case 'image':
            return `${node.role} image`
          case 'activity':
            return `worked · ${node.unit.count} operations`
          case 'fallback':
            return `fallback · ${node.label}`
          case 'system':
            return node.system.type === 'entry'
              ? `system · ${node.system.entry.type}`
              : node.system.type === 'work'
                ? `work · ${node.system.phase}`
                : `waiting for ${node.system.provider}`
        }
      })()
      return {
        key: node.id,
        slot,
        label,
        itemType: `presentation:${node.kind}`,
        order: node.order,
      }
    }),
    [presentation.nodes],
  )
  const visibleEntryCount = renderItems.filter(item => item.type === 'entry').length
  // #491: semantic items are now block-level (semantic-block/-collapsed-activity/
  // -text), each tagged with its turn's owner. Derive the same debug signals the
  // old turn-level items exposed — unique history turnIds, and "is the current
  // turn on screen" — from the block items' owner+turnId.
  const renderedSemanticHistoryTurnIds = useMemo(() => {
    const seen = new Set<string>()
    const ids: string[] = []
    for (const item of renderItems) {
      if (
        (item.type === 'semantic-block' ||
          item.type === 'semantic-collapsed-activity' ||
          item.type === 'semantic-text') &&
        item.owner === 'semantic-history' &&
        !seen.has(item.turnId)
      ) {
        seen.add(item.turnId)
        ids.push(item.turnId)
      }
    }
    return ids
  }, [renderItems])
  // The current live turn IS rendered iff any block item carries owner
  // 'semantic-current'. WorkIndicator's tool-hint reads the full turn, which
  // Feed already has as the `semanticTurn` prop — return that when present.
  const renderedSemanticTurn = useMemo(() => {
    const currentOnScreen = renderItems.some(
      item =>
        (item.type === 'semantic-block' ||
          item.type === 'semantic-collapsed-activity' ||
          item.type === 'semantic-text') &&
        item.owner === 'semantic-current',
    )
    return currentOnScreen ? semanticTurn : null
  }, [renderItems, semanticTurn])

  // Feed-debug emission — the "debug == paint" half of the painter,
  // ported verbatim into ui/hooks/useFeedDebugEmission.ts.
  useFeedDebugEmission({
    onDebugLog,
    entriesLength: entries.length,
    visibleEntryCount,
    renderedRows,
    visibleDecisions,
    semanticTurnId: semanticTurn?.turnId ?? null,
    renderedSemanticHistoryTurnIds,
    streamPhase,
    projectionReceipts: presentation.receipts,
  })

  const renderPresentationNode = (node: (typeof presentation.nodes)[number]) => {
    // Every node uses LazyEntry, including ephemeral semantic nodes. WHY: an
    // operation can switch from semantic evidence (no entry ordinal) to a
    // committed entry while retaining its correlation key. Keeping the wrapper
    // component type constant prevents that hand-off from remounting the
    // OperationRow and losing expansion/scroll state. Semantic/work nodes are
    // eager, so they still render immediately.
    const eager =
      node.entryOrdinal === null ||
      node.entryOrdinal >= visibleEntryCount - EAGER_TAIL
    const work = node.kind === 'system' && node.system.type === 'work'
      ? node.system
      : null
    return (
      <div
        key={node.id}
        data-entry-uuid={node.entryUuid ?? undefined}
        data-presentation-kind={node.kind}
      >
        <LazyEntry
          eager={eager}
          suspended={bootstrapping}
          scrollerRef={scrollerRef}
        >
          <PresentationRow
            node={node}
            turnStartedAt={turnStartedAt}
            toolHint={work
              ? toolHintFromTurn(renderedSemanticTurn, work.toolUseId)
              : null}
          />
        </LazyEntry>
      </div>
    )
  }

  return (
    <ToolResultIndexContext.Provider value={toolResultIndex}>
      <SubAgentsContext.Provider value={subAgents}>
        <TaskNotificationsContext.Provider value={taskNotifications}>
          <AskUserQuestionConditionContext.Provider value={askUserQuestionState}>
            <CodeRenderContext.Provider value={{ sessionId, workspaceRoot }}>
              <div
                ref={scrollerRef}
                className="relative h-full overflow-auto @container"
                onWheel={() => {
                  onUserEngagement?.()
                }}
                onPointerDown={() => {
                  onUserEngagement?.()
                }}
              >
        {/* Container-query responsive (mobile-feed-rewrite Part A). This node
         *  is SHARED with the desktop and with narrow tiled panes, so the
         *  WIDEST step (@min-[768px]) restores the historical desktop classes
         *  VERBATIM — wide output must not change (regression invariant). Only
         *  narrow widths (phone, skinny tiles) diverge: they drop the max-w cap
         *  and shrink the gutters, instead of eating 64px of px-8 on a ~375px
         *  screen. The scroller above carries `@container` so these variants
         *  respond to the FEED's own width, not the viewport — which is why a
         *  narrow desktop tile benefits identically to a phone. */}
                <div className="min-h-full flex flex-col gap-4 mx-auto px-3 pt-3 pb-6 @min-[480px]:px-5 @min-[480px]:pt-5 @min-[768px]:max-w-[880px] @min-[768px]:px-8 @min-[768px]:pt-6 @min-[768px]:pb-8">
          {/* ONE owner rule for every visible feed surface.
           *
           * The old JSX rendered separate buckets in a fixed order:
           * committed entries first, semantic history/current later,
           * work last. That let a
           * stale semantic history row mount under a newer submitted
           * prompt, which looked exactly like "my user prompt never
           * rendered" in real conversations. Feed now consumes the
           * selector's single ordered item list so ownership,
           * chronological placement, debug rows, and lazy-entry
           * eagerness all share one render contract. Queued prompts
           * remain composer-adjacent because they are pending input,
           * not transcript history. */}
                  {presentation.nodes.map(renderPresentationNode)}
                  <div ref={endRef} />
                </div>
                {/* The assistant picker spans several flattened nodes without
                    wrapping/reparenting them. This empty host is deliberately
                    outside the keyed row list; the hook owns its one transient
                    overlay and cleans it on selection change. */}
                <div
                  data-entry-selection-layer
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-10"
                />
              </div>
            </CodeRenderContext.Provider>
          </AskUserQuestionConditionContext.Provider>
        </TaskNotificationsContext.Provider>
      </SubAgentsContext.Provider>
    </ToolResultIndexContext.Provider>
  )
}
