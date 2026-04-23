import {
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import ReactMarkdown from 'react-markdown'

import {
  EditRow,
  MultiEditRow,
  WriteRow,
  TodoRow,
} from '@providers/claude/renderer/rows/ClaudeRows'
import {
  CodexToolRow,
  CodexToolResultRow,
} from '@providers/codex/renderer/rows/CodexRows'
import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
  type ContentBlock,
  type CompactSummaryEntry,
  type ConversationEntry,
  type Entry,
  type ToolResultBlock,
  type ToolUseBlock,
} from '@shared/types/transcript'
import { CodeBlock } from '../../../lib/code/CodeBlock'
import { detectGitIntent } from '@shared/git/gitDetect'
import { GitCardRow } from '../../git/ui/GitRows'
import { useAppStore } from '../../../state/hooks'
import {
  parseSemanticTodos,
  type SemanticLiveTurn,
  type SemanticTodoItem,
  type StreamPhase,
} from '../../../workspace/workspaceState'
import { WorkIndicator } from '../WorkIndicator'
import { toolHintFromTurn } from '../workIndicatorHints'
import { MarkerRow } from './MarkerRow'
import {
  ProviderContext,
  ToolUseIndexContext,
  ToolResultIndexContext,
  CodeRenderContext,
} from '../context'
import {
  type AgentProvider,
  type ScrollInfo,
  type VisibleDecision,
  type DebugVisibleRow,
} from '../types'
import { scrollPositions } from '../scroll'
import { COMPLETED_REMARK, STREAMING_REMARK } from '../lib/remark-plugins'
import {
  buildToolUseIndex,
  buildToolResultIndex,
  extractToolCommand,
  toolResultText,
  truncateBashCommand,
  stripLineNumberPrefix,
  debugKeyForEntry,
  debugLabelForEntry,
  countFenceMarkers,
  splitStreamingCodeFence,
  imageDataUrl,
  compactSummaryText,
  truncateCompactSummary,
  attachmentLabel,
  classifySemanticToolActivity,
} from '../lib/helpers'

// Re-export — many external callers import these types from Feed
// directly rather than reaching into ../types/../context. Keep the
// alias stable until the sweep is over.
export type { AgentProvider, ScrollInfo } from '../types'
export { CodeRenderContext } from '../context'

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

// COMPLETED_REMARK / STREAMING_REMARK moved to ../lib/remark-plugins.ts
// ProviderContext + ToolUseIndexContext + ToolResultIndexContext +
// CodeRenderContext moved to ../context.tsx — see those files for
// the full rationale. Feed.tsx re-exports CodeRenderContext above
// to keep external import paths stable.

/**
 * Custom <pre> renderer: strips the default <pre> wrapper and lets
 * our MarkdownCode component handle ALL the rendering for fenced
 * code blocks. Without this, react-markdown wraps block code in
 * <pre><code class="language-X">…</code></pre> and our CodeBlock
 * would be nested inside the browser's default <pre> styling.
 *
 * Inline code is NOT affected — inline `code` never gets a <pre>
 * wrapper in react-markdown's output.
 */
function MarkdownPre({
  children,
  node,
}: {
  children?: ReactNode
  node?: unknown
}) {
  // Tag the children so MarkdownCode knows this code element came
  // from inside a <pre> (i.e., it's a fenced/indented code block,
  // not an inline backtick). We pass through the children as-is;
  // the <pre> wrapper is removed.
  void node
  return <>{children}</>
}

/**
 * Custom <code> renderer. Handles two distinct cases:
 *
 * 1. INLINE code: `variableName` in prose. Detected by the absence
 *    of a `language-*` className AND single-line text. Renders as a
 *    plain <code> element with the existing prose-theme inline-code
 *    styling (accent color, no background).
 *
 * 2. FENCED code blocks: ```language\n...\n```. Detected by the
 *    presence of a `language-*` className OR multi-line text (which
 *    means it came through MarkdownPre above). Renders via CodeBlock
 *    with syntax highlighting.
 *
 * Why the className + newline heuristic:
 *   react-markdown v10 doesn't pass a reliable `inline` prop to the
 *   code component. The only signals are: (a) fenced blocks get
 *   className="language-X" when labeled, (b) fenced blocks have
 *   newlines in their text, (c) inline code has neither. Checking
 *   both catches labeled fences, unlabeled fences (multi-line), and
 *   inline backticks.
 */
function MarkdownCode({
  className,
  children,
}: {
  className?: string
  children?: ReactNode
}) {
  const { sessionId, workspaceRoot } = useContext(CodeRenderContext)
  const text = String(children ?? '').replace(/\n$/, '')
  const language = className?.match(/language-([\w-]+)/)?.[1] ?? null

  // Inline code: no language class AND no newlines → plain <code>.
  // This preserves the existing prose-theme styling where inline
  // code is accent-colored with no background chip.
  const isInline = !language && !text.includes('\n')
  if (isInline) {
    return <code>{children}</code>
  }

  // Fenced/indented code block inside prose → static highlight.js.
  // NOT Monaco — Monaco is heavyweight (async loader, canvas
  // renderer, explicit layout) and a single assistant turn often
  // contains several fenced blocks. When many Monaco editors mount
  // into narrow flex cells before the parent layout has resolved,
  // they initialise at width=0, paint nothing, and `automaticLayout`
  // does not always recover on the follow-up resize — the block
  // ends up as the dark `--theme-code-bg` background with no
  // visible text (the "black block" bug). Monaco stays reserved for
  // surfaces where an editor actually pays off: Read / Grep tool
  // results, where LSP and scrollable syntax highlighting matter.
  // Prose blocks are "here's a shell command"; static is the right
  // fit.
  //
  // `allowAutoDetect` on unlabeled fences restores the old
  // rehype-highlight detect:true behavior.
  return (
    <CodeBlock
      code={text}
      language={language}
      workspaceRoot={workspaceRoot}
      codeId={`${sessionId}:${text.slice(0, 24)}`}
      engine="static"
      allowAutoDetect={!language}
    />
  )
}

const MARKDOWN_COMPONENTS: import('react-markdown').Options['components'] = {
  pre: MarkdownPre,
  code: MarkdownCode,
}

// buildToolUseIndex / buildToolResultIndex / extractToolCommand /
// toolResultText moved to ../lib/helpers.ts. AgentProvider and
// ScrollInfo types moved to ../types.ts; re-exported at the top of
// this file.

type Props = {
  /** Session identity — used as the key for per-session scroll
   *  position persistence across Feed unmount/remount (tab switches).
   *  See `scrollPositions` below. */
  sessionId: string
  /** Which provider's row renderers to use. Default 'claude'. */
  provider?: AgentProvider
  entries: Entry[]
  /** Spinner verb text from the headless package ("Cogitating…").
   *  Kept for DebugPanel visibility; no longer drives feed rendering
   *  now that `streamPhase` owns the working indicator. */
  activityStatus?: string | null
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
  workspaceRoot?: string | null
  /** Called on every scroll tick with the current position. */
  onScrollInfo?: (info: ScrollInfo) => void
  hasOlderHistory?: boolean
  loadingOlderHistory?: boolean
  onLoadOlderHistory?: () => Promise<void>
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
// reducer (`reconcileUpstream` in src/renderer/src/workspace/ghosts.ts)
// supersedes Codex text ghosts by rollout response id once the
// rollout mapper stamps `codexTurnId` on committed entries
// (src/renderer/src/workspace/workspaceStore.ts::codexTurnIdFromRollout
// + stampCodexTurnId). The live view and the merged feed are split
// by turn ownership (src/renderer/src/workspace/mergedEntries.ts), so
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
//      picker visibility change), Feed sees the same `entries` reference,
//      same `streamingScreen`, etc., and React.memo's default shallow
//      compare bails the entire subtree out. Zero markdown work happens.
//
//   2. Every row component (`EntryRow`, `ConversationRow`, `TextProse`,
//      `ToolUseRow`, `ToolResultRow`) is individually memoized. Even when
//      Feed DOES need to re-render (new entry lands, streaming frame
//      ticks), existing rows receive the exact same entry/block/text
//      reference they had last time and skip. Only the genuinely new
//      row does parse work. This matters because entries are appended,
//      not replaced — we spread `[...current.entries, newOne]`, so the
//      array reference is fresh but every existing element is stable.
//
// TextProse/StreamingProse are the hottest leaf; memoizing them by the
// `text` string is the single biggest win because ReactMarkdown itself
// has no memo and re-parses on every call.
//
// What is NOT memoized on purpose: the StreamingRow. It WANTS to re-run
// on every screen frame — that's literally the streaming preview. But
// even there, `StreamingProse` is memoed by the extracted text string,
// so identical consecutive frames (which are common — CC re-renders its
// screen buffer without the content changing) are free.

export const Feed = memo(FeedImpl)

function FeedImpl({
  sessionId,
  provider = 'claude',
  entries,
  activityStatus,
  streamPhase = 'idle',
  streamPhasePendingToolName = null,
  streamPhasePendingToolUseId = null,
  turnStartedAt = null,
  tailMode = false,
  pickerSelectedUuid = null,
  workspaceRoot = null,
  onScrollInfo,
  hasOlderHistory = false,
  loadingOlderHistory = false,
  onLoadOlderHistory,
  semanticTurn = null,
  bootstrapping = false,
  scrollToLatestRequest = 0,
  toolUseIndex: toolUseIndexProp,
  toolResultIndex: toolResultIndexProp,
  onDebugLog,
}: Props) {
  // Scroll container owned by Feed itself — not by TileLeaf — so the
  // sticky-bottom logic below can own its own scroll listener without
  // reaching up the tree. TileLeaf's wrapper is just a flex cell and
  // no longer sets overflow-auto; see TileLeaf.tsx for the pair.
  //
  // Why this is load-bearing: during active streaming, `streamingScreen`
  // updates at ~60Hz. A naive useEffect([streamingScreen]) that calls
  // scrollIntoView({block:'end'}) every time would yank the viewport
  // to the bottom on every frame, making it impossible for the user
  // to scroll up and read earlier content. Even when NOT streaming,
  // the same effect fires whenever the streaming-ish prop flickers —
  // which can happen unexpectedly if some other piece of state (e.g.
  // the queue handler forcing awaitingAssistant=true from a phantom
  // backlog) keeps the prop live. Worth repeating the user's
  // diagnosis: "scrolling doesn't even work, it snaps me back to the
  // bottom super glitchly." That's exactly the behavior the old
  // effect produced.
  //
  // The fix is two-part:
  //   1. Track "is the user near the bottom right now" in a ref
  //      that's updated by a scroll listener. "Near" = within 48px
  //      of the bottom; the pad absorbs sub-pixel rounding and the
  //      natural momentum overshoot when new rows land.
  //   2. Only auto-scroll when the ref is true. If the user has
  //      scrolled up, stickyBottom becomes false, and subsequent
  //      updates stop forcing the viewport down. When the user
  //      scrolls back to the bottom, the ref flips true again and
  //      auto-scroll resumes.
  //
  // Using a ref (not state) for stickyBottom is deliberate: we don't
  // want a React re-render on every scroll tick, only a read in the
  // auto-scroll effect. Scroll events fire on EVERY pixel, so this
  // matters.
  const scrollerRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  // Restore stickyBottom from the persisted map on first render so
  // the auto-scroll effect below makes the right decision without
  // needing to wait for the scroll listener to run. Defaults to
  // true for brand-new sessions (no saved position yet).
  const stickyBottomRef = useRef(
    scrollPositions.get(sessionId)?.stickyBottom ?? true,
  )
  const loadingOlderRef = useRef(false)
  // Was there an existing saved scroll position for this session when
  // this Feed instance mounted? Used to distinguish "restore the
  // user's deliberate scrolled-up position" from "brand-new/resumed
  // session should land at latest content even if stickyBottom got
  // transiently knocked false during bootstrap."
  const hadSavedPositionOnMountRef = useRef(scrollPositions.has(sessionId))
  // Previous scrollTop, used to distinguish "the user started
  // scrolling upward" from incidental near-bottom jitter. This is
  // load-bearing during active turns: with the old "gap < 48"
  // heuristic alone, a tiny upward wheel tick still counted as
  // sticky, and the next ~60 Hz screen update snapped the feed right
  // back down before the user could accumulate enough distance to
  // escape. Any real upward movement should break follow
  // immediately; re-follow only when the user intentionally returns
  // near the bottom.
  const lastScrollTopRef = useRef(0)

  // Restore the saved scroll position on mount — synchronously, via
  // useLayoutEffect, so the browser never paints the scroller at
  // scrollTop=0 before we restore. Using useEffect here would flash
  // the top of the feed for one frame before the restore landed.
  //
  // Three cases:
  //   1. No saved entry → this is the first time we've mounted for
  //      this session (or the map was just cleared). Default to
  //      "stuck at bottom" — for a freshly-opened feed the user
  //      wants to see the most recent content, just like opening a
  //      terminal or a chat window.
  //   2. Saved stickyBottom: true → the user was at the bottom when
  //      they left. Content may have grown while we were unmounted
  //      (new entries appended to runtime.entries even though Feed
  //      wasn't rendering), so we pin to the NEW scrollHeight, not
  //      the old scrollTop.
  //   3. Saved stickyBottom: false → restore the exact saved
  //      scrollTop. Content height on remount matches save time
  //      (because unmount freezes new entries from growing the
  //      unmounted scroller) so this is pixel-accurate.
  //
  // The sessionId dep is load-bearing: if the user resumes a
  // different session in the same pane slot, we need to re-restore
  // from the new key. Today it's effectively a mount-only effect.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    hadSavedPositionOnMountRef.current = scrollPositions.has(sessionId)
    if (tailMode) {
      el.scrollTop = el.scrollHeight
      stickyBottomRef.current = true
      lastScrollTopRef.current = el.scrollTop
      return
    }
    const saved = scrollPositions.get(sessionId)
    if (!saved || saved.stickyBottom) {
      // Case 1 or 2: pin to bottom. We do this synchronously in
      // useLayoutEffect so the browser commits the scrollTop change
      // in the SAME paint as the initial content render. Without
      // that, the first paint shows scrollTop=0 (top) and the next
      // tick scrolls down — visibly a "starts at top, jumps to
      // bottom" flash on every tab switch, which is the exact bug
      // the user flagged.
      el.scrollTop = el.scrollHeight
      stickyBottomRef.current = true
      lastScrollTopRef.current = el.scrollTop
    } else {
      // Case 3: restore exact position.
      el.scrollTop = saved.scrollTop
      stickyBottomRef.current = false
      lastScrollTopRef.current = el.scrollTop
    }
  }, [sessionId, tailMode])

  // One scroll listener for the container. Updates stickyBottomRef
  // imperatively AND persists the position into the module-level
  // map so a later unmount/remount can restore it.
  //
  // CRITICAL: we DO NOT call onScroll() synchronously on mount.
  // That was the original bug — at mount time the scroller has
  // scrollTop=0 and scrollHeight=full-content, so gap > 48 and the
  // handler would stamp stickyBottom=false INTO THE REF AND THE
  // PERSISTED MAP before the layout effect above had a chance to
  // scroll to the bottom. Then the auto-scroll effect below would
  // see stickyBottom=false and skip, leaving the viewport stuck at
  // the top. The layout effect sets stickyBottomRef explicitly, so
  // the scroll listener only needs to react to actual user scrolls.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = () => {
      if (tailMode) {
        el.scrollTop = el.scrollHeight
        stickyBottomRef.current = true
        lastScrollTopRef.current = el.scrollTop
        scrollPositions.set(sessionId, {
          scrollTop: el.scrollTop,
          stickyBottom: true,
        })
        if (onScrollInfo) onScrollInfo({ fraction: 0 })
        return
      }
      const gap = el.scrollHeight - (el.scrollTop + el.clientHeight)
      const scrollingUp = el.scrollTop < lastScrollTopRef.current
      const nearBottom = gap < 48
      stickyBottomRef.current =
        scrollingUp && gap > 0 ? false : nearBottom
      lastScrollTopRef.current = el.scrollTop
      scrollPositions.set(sessionId, {
        scrollTop: el.scrollTop,
        stickyBottom: stickyBottomRef.current,
      })
      // Push scroll position to parent for the scroll indicator.
      // fraction=0 at bottom, fraction=1 at top.
      if (onScrollInfo) {
        const maxScroll = el.scrollHeight - el.clientHeight
        const fraction = maxScroll > 0
          ? 1 - (el.scrollTop / maxScroll)
          : 0
        onScrollInfo({ fraction })
      }

      if (
        el.scrollTop < 160 &&
        hasOlderHistory &&
        !loadingOlderHistory &&
        !loadingOlderRef.current &&
        !tailMode &&
        onLoadOlderHistory
      ) {
        loadingOlderRef.current = true
        const beforeHeight = el.scrollHeight
        const beforeTop = el.scrollTop
        void onLoadOlderHistory()
          .then(() => {
            requestAnimationFrame(() => {
              const next = scrollerRef.current
              if (!next) return
              const delta = next.scrollHeight - beforeHeight
              next.scrollTop = beforeTop + Math.max(0, delta)
              lastScrollTopRef.current = next.scrollTop
            })
          })
          .finally(() => {
            loadingOlderRef.current = false
          })
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [
    sessionId,
    onScrollInfo,
    tailMode,
    hasOlderHistory,
    loadingOlderHistory,
    onLoadOlderHistory,
  ])

  // Auto-scroll on content changes, but ONLY when sticky. The effect
  // runs on every change that would grow the feed (a new entry) or
  // move the streaming tail (a new streamingScreen snapshot). If the
  // user is scrolled up, we skip — they're reading earlier content
  // and we don't want to yank them back.
  //
  // Semantic streaming (the proxy-driven live turn) also grows the
  // bottom of the feed without touching `streamingScreen` or
  // `entries`. Include a cheap fingerprint of the current semantic
  // turn (its text length plus the count of blocks) so the effect
  // re-runs when semantic deltas land — otherwise a Codex/proxy
  // session that never populates the legacy screen snapshot won't
  // follow the tail even when the user is at the bottom.
  const semanticTurnSignal = semanticTurn
    ? `${semanticTurn.turnId}:${semanticTurn.text.length}:${Object.keys(semanticTurn.blocks).length}`
    : ''
  useEffect(() => {
    // During a bulk bootstrap burst we skip per-append auto-scroll.
    // The pin-once-on-transition effect below lands us at the bottom
    // in a single operation after the burst ends — otherwise every
    // entry appended during the burst would pin-scroll and wake up
    // the LazyEntry observer cascade. See docs/superpowers/plans/
    // 2026-04-15-bootstrap-replay-perf.md.
    if (bootstrapping) return
    if (!tailMode && !stickyBottomRef.current) return
    // scrollTop = scrollHeight pins to bottom without the smooth-scroll
    // overshoot scrollIntoView sometimes produces. Direct, instant,
    // no animation frames.
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length, tailMode, semanticTurnSignal, bootstrapping])

  // Pin-once on the bootstrap → live transition. Runs exactly once per
  // transition thanks to the previous-value ref: we read the prior
  // value, compare, pin if we just left bootstrap mode, then store the
  // new value for next time. No dependency on `entries.length` so the
  // effect does not fire on subsequent live appends — those go
  // through the regular auto-scroll effect above.
  const prevBootstrappingRef = useRef(false)
  useEffect(() => {
    if (prevBootstrappingRef.current && !bootstrapping) {
      const el = scrollerRef.current
      // Fresh/resumed sessions with no saved scroll position should
      // ALWAYS land on the latest content after the bootstrap burst.
      // Relying purely on stickyBottomRef here is fragile because the
      // initial mount/placeholder/lazy-load sequence can transiently
      // mark the feed non-sticky before the first real user scroll.
      // That leaves the viewport stranded above the eager tail: the
      // exact "blank until I scroll down a couple pages" symptom.
      const shouldForceInitialBottom =
        !hadSavedPositionOnMountRef.current && !tailMode
      if (el && (tailMode || stickyBottomRef.current || shouldForceInitialBottom)) {
        el.scrollTop = el.scrollHeight
        stickyBottomRef.current = true
        lastScrollTopRef.current = el.scrollTop
        scrollPositions.set(sessionId, {
          scrollTop: el.scrollTop,
          stickyBottom: true,
        })
        if (onScrollInfo) onScrollInfo({ fraction: 0 })
      }
    }
    prevBootstrappingRef.current = bootstrapping
  }, [bootstrapping, onScrollInfo, sessionId, tailMode])

  // When the picker selection changes, smoothly tween the scroller
  // so the highlighted entry centers in the viewport.
  //
  // We do NOT use native scrollIntoView({behavior:'smooth'}) because:
  //   - With block:'nearest' it no-ops when the target is already on
  //     screen, so rapid arrow presses after a manual scroll land on
  //     already-visible entries and produce zero motion (user report:
  //     "my arrow key does nothing after I scroll").
  //   - With block:'center' native smooth scroll was observably shaky
  //     here — the feed's own scroll listener fires on every frame of
  //     the animation and was fighting the browser's scroll queue.
  //
  // A custom rAF tween is ~20 lines, interrupt-safe (new target
  // cancels any in-flight animation), and completely independent of
  // whatever the scroll listener is doing.
  const scrollAnimFrameRef = useRef<number | null>(null)
  useEffect(() => {
    if (!pickerSelectedUuid) return
    const root = scrollerRef.current
    if (!root) return
    const target = root.querySelector(
      `[data-entry-uuid="${pickerSelectedUuid}"]`,
    ) as HTMLElement | null
    if (!target) return

    // Compute desired scrollTop so the target's vertical center aligns
    // with the scroller's vertical center. Clamp to the scroller's
    // scrollable range so we don't try to scroll past start/end.
    const targetCenter = target.offsetTop + target.offsetHeight / 2
    const desired = targetCenter - root.clientHeight / 2
    const maxScroll = root.scrollHeight - root.clientHeight
    const to = Math.max(0, Math.min(maxScroll, desired))
    const from = root.scrollTop
    const distance = to - from
    if (Math.abs(distance) < 1) return

    // Cancel any in-flight animation so rapid Up/Down presses don't
    // compound into a runaway scroll.
    if (scrollAnimFrameRef.current !== null) {
      cancelAnimationFrame(scrollAnimFrameRef.current)
      scrollAnimFrameRef.current = null
    }

    const duration = 180
    const startTime = performance.now()
    const ease = (t: number) => 1 - Math.pow(1 - t, 3) // easeOutCubic

    const step = (now: number) => {
      const elapsed = now - startTime
      const t = Math.min(1, elapsed / duration)
      root.scrollTop = from + distance * ease(t)
      if (t < 1) {
        scrollAnimFrameRef.current = requestAnimationFrame(step)
      } else {
        scrollAnimFrameRef.current = null
      }
    }
    scrollAnimFrameRef.current = requestAnimationFrame(step)

    return () => {
      if (scrollAnimFrameRef.current !== null) {
        cancelAnimationFrame(scrollAnimFrameRef.current)
        scrollAnimFrameRef.current = null
      }
    }
  }, [pickerSelectedUuid])

  useEffect(() => {
    if (scrollToLatestRequest === 0) return
    const el = scrollerRef.current
    if (!el) return
    if (scrollAnimFrameRef.current !== null) {
      cancelAnimationFrame(scrollAnimFrameRef.current)
      scrollAnimFrameRef.current = null
    }
    el.scrollTop = el.scrollHeight
    stickyBottomRef.current = true
    lastScrollTopRef.current = el.scrollTop
    scrollPositions.set(sessionId, {
      scrollTop: el.scrollTop,
      stickyBottom: true,
    })
    if (onScrollInfo) onScrollInfo({ fraction: 0 })
  }, [onScrollInfo, scrollToLatestRequest, sessionId])

  // Visible entries skip system/meta noise by default. isMeta entries are
  // CC's system-injected user-role
  // messages: task-notification results from subagents, auto-continue
  // hints ("Continue from where you left off."), system-reminder
  // payloads, etc. They carry `isMeta: true` on the entry but pass
  // the isConversationEntry check because they have type='user' and
  // a real message object. Without this filter, a background agent's
  // completion notification would render as a full UserBand in the
  // feed with raw <task-notification> XML visible — exactly the bug
  // the user reported.
  const visibleDecisions = useMemo<VisibleDecision[]>(
    () =>
      entries.map((entry, index) => {
        if (isCompactBoundaryEntry(entry)) {
          return {
            key: debugKeyForEntry(entry, index),
            entry,
            visible: true,
            reason: 'compact_boundary',
          }
        }
        if (isCompactSummaryEntry(entry)) {
          return {
            key: debugKeyForEntry(entry, index),
            entry,
            visible: true,
            reason: 'compact_summary',
          }
        }
        if (!isConversationEntry(entry)) {
          return {
            key: debugKeyForEntry(entry, index),
            entry,
            visible: false,
            reason: 'not_conversation',
          }
        }
        if ((entry as unknown as { isMeta?: boolean }).isMeta === true) {
          return {
            key: debugKeyForEntry(entry, index),
            entry,
            visible: false,
            reason: 'meta_filtered',
          }
        }
        return {
          key: debugKeyForEntry(entry, index),
          entry,
          visible: true,
          reason: 'conversation',
        }
      }),
    [entries],
  )

  const visible = useMemo(
    () => visibleDecisions.filter(item => item.visible).map(item => item.entry),
    [visibleDecisions],
  )

  // Live view is owned 1:1 by `semanticTurn` now — the old Codex-only
  // suppression helper (`shouldSuppressSemanticTurnForCommittedTail`)
  // was deleted in 2026-04-20 because the ghost reducer handles the
  // duplicate-render class at its source. See Feed.tsx history and
  // docs/superpowers/plans/2026-04-20-rendering-fixes.md Task 6.
  const renderedSemanticTurn = semanticTurn

  // Index EVERY tool_use block (not just the visible set) so tool_result
  // lookups still resolve even when some synthetic entries have been
  // filtered out. The index is cheap to
  // build (single pass) and the resulting Map is handed to result rows
  // via context.
  // Incremental indices live on the runtime and grow at entry-ingest
  // time (see workspaceStore.indexEntryIntoMaps). When Feed is mounted
  // outside the workspace store (tests, future surfaces) the props
  // are unset and we fall back to building the maps once from
  // `entries`. The fallback useMemo is unconditional — React's rules
  // forbid conditional hooks, so we always call it; the `.has(0)`
  // shortcut keeps cost negligible when the props are present.
  const fallbackToolUseIndex = useMemo(() => buildToolUseIndex(entries), [entries])
  const fallbackToolResultIndex = useMemo(() => buildToolResultIndex(entries), [entries])
  const toolUseIndex = toolUseIndexProp ?? fallbackToolUseIndex
  const toolResultIndex = toolResultIndexProp ?? fallbackToolResultIndex

  const hasSemanticStreaming = renderedSemanticTurn !== null
  const shouldShowWorkIndicator = streamPhase !== 'idle'

  const renderedRows = useMemo<DebugVisibleRow[]>(() => {
    if (visible.length === 0 && !hasSemanticStreaming) {
      return [{
        key: 'empty',
        slot: 'empty',
        label: provider === 'codex' ? 'waiting for Codex…' : 'waiting for Claude Code…',
      }]
    }
    const rows: DebugVisibleRow[] = visibleDecisions
      .filter(item => item.visible)
      .map(item => ({
        key: `entry:${item.key}`,
        slot: 'entry',
        label: debugLabelForEntry(item.entry),
      }))
    if (renderedSemanticTurn != null) {
      rows.push({
        key: `semantic:${renderedSemanticTurn.turnId}`,
        slot: 'semantic',
        label: `semantic turn ${renderedSemanticTurn.turnId.slice(0, 12)} · ${renderedSemanticTurn.source ?? 'unknown'}`,
      })
    }
    if (shouldShowWorkIndicator) {
      rows.push({
        key: `work:${streamPhase}:${streamPhasePendingToolUseId ?? 'none'}`,
        slot: 'work',
        label:
          streamPhasePendingToolName && (
            streamPhase === 'tool-input' ||
            streamPhase === 'tool-use' ||
            streamPhase === 'awaiting-tool'
          )
            ? `work ${streamPhase} · ${streamPhasePendingToolName}`
            : `work ${streamPhase}`,
      })
    }
    return rows
  }, [
    hasSemanticStreaming,
    provider,
    renderedSemanticTurn,
    shouldShowWorkIndicator,
    streamPhase,
    streamPhasePendingToolName,
    streamPhasePendingToolUseId,
    visible.length,
    visibleDecisions,
  ])

  const previousRenderedRowsRef = useRef<DebugVisibleRow[] | null>(null)

  useEffect(() => {
    if (!onDebugLog) return
    const previous = previousRenderedRowsRef.current
    const prevKeys = new Set(previous?.map(row => row.key) ?? [])
    const nextKeys = new Set(renderedRows.map(row => row.key))
    const added = renderedRows.filter(row => !prevKeys.has(row.key))
    const removed = (previous ?? []).filter(row => !nextKeys.has(row.key))
    const hidden = visibleDecisions
      .filter(item => !item.visible)
      .slice(-12)
      .map(item => ({
        key: item.key,
        label: debugLabelForEntry(item.entry),
        reason: item.reason,
      }))
    const changed =
      previous === null ||
      added.length > 0 ||
      removed.length > 0 ||
      previous.length !== renderedRows.length ||
      previous.some((row, index) => row.key !== renderedRows[index]?.key)
    if (!changed) return
    onDebugLog({
      layer: 'RENDER',
      kind: 'visible_rows',
      summary:
        previous === null
          ? `initial rows ${renderedRows.length}`
          : `rows ${previous.length} -> ${renderedRows.length} (+${added.length} -${removed.length})`,
      data: {
        rows: renderedRows,
        added,
        removed,
        hidden,
        entryCount: entries.length,
        visibleEntryCount: visible.length,
        semanticTurnId: semanticTurn?.turnId ?? null,
        streamPhase,
      },
    })
    previousRenderedRowsRef.current = renderedRows
  }, [entries.length, onDebugLog, renderedRows, semanticTurn?.turnId, streamPhase, visible.length, visibleDecisions])

  if (visible.length === 0 && !hasSemanticStreaming) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-muted text-[12px]">
          {provider === 'codex' ? 'waiting for Codex…' : 'waiting for Claude Code…'}
        </div>
      </div>
    )
  }

  return (
    <ProviderContext.Provider value={provider}>
    <ToolUseIndexContext.Provider value={toolUseIndex}>
    <ToolResultIndexContext.Provider value={toolResultIndex}>
    <CodeRenderContext.Provider value={{ sessionId, workspaceRoot }}>
      <div
        ref={scrollerRef}
        className="h-full overflow-auto"
      >
        <div className="max-w-[880px] mx-auto px-8 pt-6 pb-8 flex flex-col gap-4">
          {visible.map((e, i) => {
            const uuid = (e as Entry).uuid
            const key = uuid ?? `i${i}`
            // The last EAGER_TAIL entries render immediately — they're
            // in or near the current viewport (the user sees the bottom
            // of the feed on load). Everything above starts as a
            // lightweight placeholder and mounts when the user scrolls
            // up to it. Once mounted, never unmounts — React.memo
            // keeps re-renders free and we avoid the re-parse cost
            // that virtualization (unmount→remount) would cause.
            const eager = i >= visible.length - EAGER_TAIL
            const selected =
              pickerSelectedUuid != null && uuid === pickerSelectedUuid
            // Wrapper carries the uuid attribute (for scrollIntoView
            // lookup) and the outline class when selected by the
            // Copy Assistant picker.
            return (
              <div
                key={key}
                data-entry-uuid={uuid ?? undefined}
                className={
                  selected
                    ? 'outline outline-2 outline-accent outline-offset-2 transition-[outline-color] duration-150'
                    : undefined
                }
              >
                <LazyEntry
                  eager={eager}
                  suspended={bootstrapping}
                  scrollerRef={scrollerRef}
                >
                  <EntryRow entry={e} />
                </LazyEntry>
              </div>
            )
          })}
          {/* ONE owner rule for live assistant text.
           *
           * Live text renders exclusively from the semantic channel
           * (claude-code-headless / codex-headless). The render-time
           * regex extractor over the raw TUI screen (`<StreamingRow>`)
           * was removed because it was a second producer for the same
           * feed slot — the structural cause of:
           *   - double-render on resume (EntryRow + StreamingRow both
           *     showing the last assistant message),
           *   - stale previous-turn text rendered under the new user
           *     message for ~seconds after submit.
           *
           * Non-proxy sessions still get live streaming: the headless
           * packages publish screen-derived semantic deltas (labelled
           * `source: 'screen'`) on the same channel, gated by a
           * baseline so they don't emit the previous turn's buffered
           * text as the first delta of a new turn. */}
          {renderedSemanticTurn != null && (
            <SemanticStreamingTurn turn={renderedSemanticTurn} />
          )}
          {/* WorkIndicator — the single in-feed "agent is working"
              affordance. Driven by `streamPhase`, NOT gated on whether
              a semantic turn is mounted. That gate was the old
              ActivityIndicator's core bug: the indicator vanished the
              moment `SemanticStreamingTurn` mounted, leaving a blind
              spot during tool execution. With phase as the driver, the
              indicator stays visible through every phase transition —
              submitting → requesting → thinking → tool-input →
              awaiting-tool → requesting (next turn) → … — and only
              disappears on terminal `idle`. See
              docs/superpowers/plans/2026-04-18-thinking-indicator-rework.md. */}
          <WorkIndicator
            phase={streamPhase}
            turnStartedAt={turnStartedAt}
            toolName={streamPhasePendingToolName}
            toolHint={toolHintFromTurn(renderedSemanticTurn, streamPhasePendingToolUseId)}
          />
          <div ref={endRef} />
        </div>
      </div>
    </CodeRenderContext.Provider>
    </ToolResultIndexContext.Provider>
    </ToolUseIndexContext.Provider>
    </ProviderContext.Provider>
  )
}

// countFenceMarkers + splitStreamingCodeFence moved to ../lib/helpers.ts.

type SemanticRenderUnit =
  | {
      type: 'block'
      block: SemanticLiveTurn['blocks'][number]
      toolState: SemanticLiveTurn['lookups']['toolCallsById'][string] | null
    }
  | {
      type: 'collapsed_activity'
      count: number
      searchCount: number
      readCount: number
      listCount: number
      bashCount: number
      latestHint: string | null
      blockIndices: number[]
      isRunning: boolean
    }

// Bash classifier helpers (COMMAND_START, atCommandPosition,
// looksLikeSearchCommand/ReadCommand/ListCommand) and
// classifySemanticToolActivity moved to ../lib/helpers.ts.

function buildSemanticRenderUnits(turn: SemanticLiveTurn): SemanticRenderUnit[] {
  const blocks = Object.values(turn.blocks).sort((a, b) => a.blockIndex - b.blockIndex)
  const units: SemanticRenderUnit[] = []
  let pending: Extract<SemanticRenderUnit, { type: 'collapsed_activity' }> | null = null

  const flush = () => {
    if (!pending) return
    units.push(pending)
    pending = null
  }

  // WHY add a derived render-unit pass before painting semantic blocks:
  //
  // Claude Code does not render raw transcript/tool rows directly for noisy
  // low-signal activity. It groups read/search/tool churn into summary units
  // first, then the UI renders those summaries. cc-shell is not at full parity
  // yet, but even this narrow pass moves us away from "one semantic block =
  // one visual row" and toward the same safer architecture.
  for (const block of blocks) {
    const toolState = block.toolUseId
      ? turn.lookups.toolCallsById[block.toolUseId] ?? null
      : null
    const activity = classifySemanticToolActivity(block)
    const isCollapsibleTool =
      (block.kind === 'tool_use' ||
        block.kind === 'server_tool_use' ||
        block.kind === 'mcp_tool_use') &&
      activity.collapsible &&
      activity.category !== null

    if (!isCollapsibleTool) {
      flush()
      units.push({ type: 'block', block, toolState })
      continue
    }

    if (!pending) {
      pending = {
        type: 'collapsed_activity',
        count: 0,
        searchCount: 0,
        readCount: 0,
        listCount: 0,
        bashCount: 0,
        latestHint: null,
        blockIndices: [],
        isRunning: false,
      }
    }

    pending.count += 1
    pending.blockIndices.push(block.blockIndex)
    pending.latestHint = activity.hint ?? pending.latestHint
    if (toolState?.status === 'in_progress') pending.isRunning = true

    if (activity.category === 'search') pending.searchCount += 1
    else if (activity.category === 'read') pending.readCount += 1
    else if (activity.category === 'list') pending.listCount += 1
    else if (activity.category === 'bash') pending.bashCount += 1
  }

  flush()
  return units
}

const SemanticStreamingTurn = memo(function SemanticStreamingTurn({
  turn,
}: {
  turn: SemanticLiveTurn
}) {
  // WHY render the semantic turn block-by-block instead of just dumping
  // `turn.text` through markdown:
  //
  // The proxy stream already tells us where text, thinking, tool_use,
  // connector_text, and tool results begin and end. If we collapse all of that
  // back into one markdown blob, we recreate the exact failure mode that made
  // screen parsing brittle: code fences, todo lists, tool boundaries, and agent
  // progress all become heuristics again. The whole point of the semantic path
  // is to stop inferring structure from terminal paint when upstream already
  // gave us the structure directly.
  const blocks = Object.values(turn.blocks).sort((a, b) => a.blockIndex - b.blockIndex)
  const units = buildSemanticRenderUnits(turn)
  const hasBlocks = blocks.length > 0

  if (!hasBlocks) {
    // WHY collapse to null instead of rendering an empty MarkerRow:
    //
    // For Codex the rollout stream does not emit per-block events, so
    // `turn.blocks` stays empty and this branch owns the entire live
    // view. `turn.text` is cleared to '' by the Codex adapter the
    // moment a `response_item` commits the current assistant message,
    // because the committed `:message` entry in the feed then owns
    // display of that text. During that transient — and between two
    // messages in the same Codex turn more broadly — there is
    // genuinely nothing the ghost should paint. An empty MarkerRow
    // would still render a solitary ⏺ bullet under the committed row,
    // which reads as a second speaker to the user.
    //
    // Returning null is correct because WorkIndicator below the feed
    // carries the "agent is working" signal on its own. See
    // docs/superpowers/plans/2026-04-18-thinking-indicator-rework.md.
    if (!turn.text) return null
    return (
      <MarkerRow marker="⏺">
        <StreamingProse text={turn.text} />
      </MarkerRow>
    )
  }

  return (
    <>
      {/* SemanticTaskSummary was removed 2026-04-18.
       *
       * The old chrome row printed `todos: X/Y · active: Bash, Grep ·
       * tools: 3 done`. It competed with WorkIndicator for "is the
       * agent working" attention without answering that question —
       * todos render via the TodoWrite tool's own SemanticLiveBlockRow,
       * active-tool names are visible in the tool rows themselves, and
       * done-count is not useful chat content.
       *
       * See docs/superpowers/plans/2026-04-18-thinking-indicator-rework.md. */}
      {units.map(unit => (
        unit.type === 'collapsed_activity' ? (
          <SemanticCollapsedActivityRow
            key={`collapsed:${unit.blockIndices.join(',')}`}
            unit={unit}
          />
        ) : (
          <SemanticLiveBlockRow
            key={unit.block.blockIndex}
            block={unit.block}
            toolState={unit.toolState}
          />
        )
      ))}
      {/* SemanticTurnFooter was removed 2026-04-18.
       *
       * It printed `stop: tool_use · in: 1234 · out: 567` — diagnostic
       * chatter that lives in DebugPanel now. If we ever want a
       * per-turn receipt card in the chat it belongs as its own
       * surface, not as a tail on every turn.
       *
       * See docs/superpowers/plans/2026-04-18-thinking-indicator-rework.md. */}
    </>
  )
})

const SemanticCollapsedActivityRow = memo(function SemanticCollapsedActivityRow({
  unit,
}: {
  unit: Extract<SemanticRenderUnit, { type: 'collapsed_activity' }>
}) {
  // Running-ness is the WorkIndicator's job now. When the group is
  // still accumulating we render nothing and let the indicator below
  // carry the "agent is working" signal. Only the `worked:` variant
  // stays — it's a genuinely useful history compaction of a finished
  // batch of reads/searches. See
  // docs/superpowers/plans/2026-04-18-thinking-indicator-rework.md.
  if (unit.isRunning) return null

  const parts: string[] = []
  if (unit.searchCount > 0) parts.push(`${unit.searchCount} search${unit.searchCount === 1 ? '' : 'es'}`)
  if (unit.readCount > 0) parts.push(`${unit.readCount} read${unit.readCount === 1 ? '' : 's'}`)
  if (unit.listCount > 0) parts.push(`${unit.listCount} list${unit.listCount === 1 ? '' : 's'}`)
  if (unit.bashCount > 0) parts.push(`${unit.bashCount} bash`)
  const summary = parts.length > 0 ? parts.join(', ') : `${unit.count} tool calls`

  return (
    <MarkerRow marker="⎿" tone="muted">
      <div className="flex flex-col gap-1">
        <div className="text-[12px] uppercase tracking-wider text-muted">
          worked: {summary}
        </div>
        {unit.latestHint ? (
          <div className="font-code text-[12px] leading-[1.5] text-ink-dim break-all">
            {unit.latestHint}
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
})

const SemanticTaskSummary = memo(function SemanticTaskSummary({
  turn,
}: {
  turn: SemanticLiveTurn
}) {
  const hasTodos = turn.task.totalCount > 0
  const activeTools = turn.task.activeToolNames
  const completedTools = turn.lookups.resolvedToolUseIds.length
  const erroredTools = turn.lookups.erroredToolUseIds.length
  if (!hasTodos && activeTools.length === 0 && completedTools === 0) return null

  // WHY keep a compact task summary above the raw blocks:
  //
  // Upstream Claude renders task/agent progress from dedicated task state, not
  // by hoping the user can mentally reconstruct it from scattered tool rows.
  // cc-shell is not at full upstream parity yet, but exposing the derived task
  // snapshot here gives the feed one stable place to surface "what is the
  // session working on right now?" without re-parsing markdown or screen text.
  return (
    <MarkerRow marker="·" tone="muted">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-wider text-muted">
        {hasTodos ? (
          <span>
            todos: {turn.task.doneCount}/{turn.task.totalCount}
          </span>
        ) : null}
        {activeTools.length > 0 ? (
          <span>
            active: {activeTools.slice(0, 3).join(', ')}
            {activeTools.length > 3 ? ` +${activeTools.length - 3}` : ''}
          </span>
        ) : null}
        {completedTools > 0 ? (
          <span>
            tools: {completedTools} done
            {erroredTools > 0 ? `, ${erroredTools} failed` : ''}
          </span>
        ) : null}
      </div>
    </MarkerRow>
  )
})

const SemanticTodoList = memo(function SemanticTodoList({
  todos,
}: {
  todos: SemanticTodoItem[]
}) {
  const done = todos.filter(todo => todo.status === 'completed').length
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[13px] leading-[1.65]">
        <span className="text-accent font-semibold">TodoWrite</span>
        <span className="text-muted text-[11px] tabular-nums">
          {done} / {todos.length} done
        </span>
      </div>
      {todos.length === 0 ? (
        <div className="text-muted text-[12px] italic">(empty list)</div>
      ) : (
        <ul className="flex flex-col gap-0.5 list-none m-0 p-0">
          {todos.map((todo, index) => {
            const glyph =
              todo.status === 'completed'
                ? '☑'
                : todo.status === 'in_progress'
                  ? '◐'
                  : '☐'
            const glyphCls =
              todo.status === 'pending' ? 'text-muted' : 'text-accent'
            const textCls =
              todo.status === 'completed'
                ? 'text-muted line-through'
                : todo.status === 'in_progress'
                  ? 'text-ink'
                  : 'text-ink-dim'
            const label =
              todo.status === 'in_progress' && todo.activeForm
                ? todo.activeForm
                : todo.content
            return (
              <li key={index} className="flex items-start gap-2 text-[13px] leading-[1.55]">
                <span
                  className={`${glyphCls} select-none flex-shrink-0 w-4 tabular-nums`}
                  aria-hidden="true"
                >
                  {glyph}
                </span>
                <span className={`${textCls} flex-1 min-w-0 break-words`}>
                  {label}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
})

const SemanticLiveBlockRow = memo(function SemanticLiveBlockRow({
  block,
  toolState,
}: {
  block: SemanticLiveTurn['blocks'][number]
  toolState: SemanticLiveTurn['lookups']['toolCallsById'][string] | null
}) {
  if (block.kind === 'thinking' || block.kind === 'reasoning') {
    // Live thinking — for Claude this is the ONLY time the plaintext is
    // available (`thinking` is stripped on the final message before
    // persisting; only signature ciphertext survives). For Codex the
    // `reasoning` block works similarly, and plaintext is frequently
    // empty because ChatGPT delivers reasoning encrypted.
    //
    // Design (2026-04-18 rework):
    //   - Empty thinking → render NOTHING. The WorkIndicator at the
    //     foot of the feed already shows "Thinking · Ns" with a
    //     pulsing dot, so the old static `∴ Thinking…` row was
    //     redundant noise that actively looked "hung" when encrypted.
    //   - Non-empty thinking → collapsed `<details>` (closed by
    //     default). Users who want to read reasoning click to expand;
    //     nobody sees a flood of italic prose they didn't ask for.
    //
    // See docs/superpowers/plans/2026-04-18-thinking-indicator-rework.md.
    const text =
      block.thinking ||
      block.reasoningSummary ||
      block.reasoningText ||
      ''
    if (!text) return null
    const isStreaming = !block.finalized
    return (
      <MarkerRow marker="⏺" tone="muted">
        <details className="italic text-muted text-[12px] opacity-80">
          <summary className="cursor-pointer select-none">
            ∴ Thinking{isStreaming ? '…' : ''}
            <span className="ml-2 not-italic text-ink-dim opacity-70">
              (click to expand)
            </span>
          </summary>
          <div className="mt-2 text-ink-dim opacity-90 not-italic">
            <StreamingProse text={text} />
          </div>
        </details>
      </MarkerRow>
    )
  }

  // Codex-specific variants — minimal first-class rendering so tool
  // calls, searches, shell commands, and image generations show up
  // live from the proxy stream instead of waiting for rollout to
  // catch up. Each variant shows what it IS (tool name / command /
  // query / status) without trying to reinvent the full rollout-
  // rendered card; rollout's reducer writes the canonical final
  // version to the feed, and these live rows fill in the "right now"
  // gap. Ordered from highest-frequency (function_call) to lowest.

  if (block.kind === 'function_call' || block.kind === 'custom_tool_call') {
    const label = block.toolName ?? block.kind
    const argsText =
      block.argumentsJson ?? block.inputJson ?? '(no arguments yet)'
    const statusBadge = block.status
      ? block.status.replace(/_/g, ' ')
      : block.finalized
        ? 'done'
        : 'running'
    return (
      <MarkerRow marker="⏺">
        <div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
            <span className="text-accent font-semibold">{label}</span>
            <span className="text-muted text-[11px] uppercase tracking-wider">
              {statusBadge}
            </span>
          </div>
          <MarkerRow marker="⎿" tone="muted">
            <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
              {argsText || '(waiting for input…)'}
            </pre>
          </MarkerRow>
          {block.parseError ? (
            <MarkerRow marker="⎿" tone="muted">
              <div className="text-danger text-[12px] leading-[1.55]">
                invalid tool input: {block.parseError}
              </div>
            </MarkerRow>
          ) : null}
        </div>
      </MarkerRow>
    )
  }

  if (
    block.kind === 'function_call_output' ||
    block.kind === 'custom_tool_call_output' ||
    block.kind === 'tool_search_output'
  ) {
    // Output blocks land as separate output_items on the SSE wire
    // (the function_call emits one item, the function_call_output
    // emits another — paired only by call_id). Render as a
    // standalone output row; downstream Feed rendering can associate
    // it with the call via the shared callId if the renderer wants to.
    const raw = block.output
    const outputText =
      typeof raw === 'string'
        ? raw
        : raw === undefined
          ? '(no output)'
          : JSON.stringify(raw, null, 2)
    return (
      <MarkerRow marker="⎿" tone="muted">
        <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-words m-0 max-h-[360px] overflow-auto">
          {outputText}
        </pre>
      </MarkerRow>
    )
  }

  if (block.kind === 'web_search_call') {
    const action = block.webSearchAction
    const label =
      action?.kind === 'search'
        ? `Search: ${action.query ?? action.queries?.join(', ') ?? '…'}`
        : action?.kind === 'open_page'
          ? `Open: ${action.url ?? '?'}`
          : action?.kind === 'find_in_page'
            ? `Find "${action.pattern ?? '?'}" in ${action.url ?? '?'}`
            : 'Web search'
    return (
      <MarkerRow marker="⏺">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">🌐 {label}</span>
          {block.status ? (
            <span className="text-muted text-[11px] uppercase tracking-wider">
              {block.status.replace(/_/g, ' ')}
            </span>
          ) : null}
        </div>
      </MarkerRow>
    )
  }

  if (block.kind === 'image_generation_call') {
    const img = block.imageGeneration
    return (
      <MarkerRow marker="⏺">
        <div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
            <span className="text-accent font-semibold">🖼 Image generation</span>
            <span className="text-muted text-[11px] uppercase tracking-wider">
              {img?.status ?? block.status ?? 'running'}
            </span>
          </div>
          {img?.revisedPrompt ? (
            <MarkerRow marker="⎿" tone="muted">
              <div className="text-ink-dim text-[12px] leading-[1.55] italic">
                {img.revisedPrompt}
              </div>
            </MarkerRow>
          ) : null}
        </div>
      </MarkerRow>
    )
  }

  if (block.kind === 'local_shell_call') {
    const shell = block.localShellCall
    const command = shell?.command.join(' ') ?? '(no command)'
    return (
      <MarkerRow marker="⏺">
        <div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
            <span className="text-accent font-semibold">$ Shell</span>
            <span className="text-muted text-[11px] uppercase tracking-wider">
              {shell?.status ?? block.status ?? 'running'}
            </span>
          </div>
          <MarkerRow marker="⎿" tone="muted">
            <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
              {command}
            </pre>
          </MarkerRow>
        </div>
      </MarkerRow>
    )
  }

  if (block.kind === 'tool_search_call') {
    const label = block.toolName ?? 'Tool search'
    return (
      <MarkerRow marker="⏺">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">🔎 {label}</span>
          {block.status ? (
            <span className="text-muted text-[11px] uppercase tracking-wider">
              {block.status.replace(/_/g, ' ')}
            </span>
          ) : null}
        </div>
      </MarkerRow>
    )
  }

  if (
    block.kind === 'tool_use' ||
    block.kind === 'server_tool_use' ||
    block.kind === 'mcp_tool_use'
  ) {
    // WHY keep tool results nested under the tool row:
    //
    // Claude's transcript wire format splits tool_use and tool_result across
    // assistant/user turns, but from a reading standpoint they are one unit of
    // work. Nesting the result here preserves that mental model during live
    // streaming and avoids another round of "find the matching tool later in the
    // feed" bookkeeping.
    const todos =
      block.toolName === 'TodoWrite'
        ? parseSemanticTodos(block.parsedInput)
        : []
    const hasResult = block.resultAt != null || block.resultContent != null
    return (
      <MarkerRow marker="⏺">
        <div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
            <span className="text-accent font-semibold">
              {block.toolName ?? block.kind}
            </span>
            {toolState ? (
              <span
                className={
                  toolState.status === 'error'
                    ? 'text-danger text-[11px] uppercase tracking-wider'
                    : 'text-muted text-[11px] uppercase tracking-wider'
                }
              >
                {toolState.status === 'in_progress'
                  ? 'running'
                  : toolState.status === 'error'
                    ? 'failed'
                    : 'done'}
              </span>
            ) : null}
          </div>
          {block.toolName === 'TodoWrite' ? (
            <SemanticTodoList todos={todos} />
          ) : (
            <MarkerRow marker="⎿" tone="muted">
              <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
                {block.inputJson || '(waiting for input…)'}
              </pre>
            </MarkerRow>
          )}
          {block.parseError ? (
            <MarkerRow marker="⎿" tone="muted">
              <div className="text-danger text-[12px] leading-[1.55]">
                invalid tool input: {block.parseError}
              </div>
            </MarkerRow>
          ) : null}
          {hasResult ? (
            <MarkerRow marker="⎿" tone="muted">
              <pre
                className={`
                  font-code text-[12px] leading-[1.55] whitespace-pre-wrap break-words m-0
                  max-h-[360px] overflow-auto
                  ${block.resultIsError ? 'text-danger' : 'text-ink-dim'}
                `}
              >
                {block.resultContent || '(empty result)'}
              </pre>
            </MarkerRow>
          ) : null}
        </div>
      </MarkerRow>
    )
  }

  const text = block.text ?? ''
  const fence = text ? splitStreamingCodeFence(text) : null
  if (fence) {
    return (
      <MarkerRow marker="⏺">
        <div className="flex flex-col gap-2">
          {fence.prose ? <StreamingProse text={fence.prose} /> : null}
          <CodeBlock
            code={fence.code}
            language={fence.language}
            codeId={`live:${block.blockIndex}:${fence.language ?? 'plain'}`}
            engine="monaco"
            allowAutoDetect={!fence.language}
          />
        </div>
      </MarkerRow>
    )
  }

  if (block.citations && block.citations.length > 0) {
    return (
      <MarkerRow marker="⏺">
        <div className="flex flex-col gap-2">
          {text ? <StreamingProse text={text} /> : null}
          <div className="text-muted text-[11px] uppercase tracking-wider">
            {block.citations.length} citation{block.citations.length === 1 ? '' : 's'}
          </div>
        </div>
      </MarkerRow>
    )
  }

  return (
    <MarkerRow marker="⏺">
      <StreamingProse text={text} />
    </MarkerRow>
  )
})

const SemanticTurnFooter = memo(function SemanticTurnFooter({
  turn,
}: {
  turn: SemanticLiveTurn
}) {
  const usage = turn.usage
  const outputTokens =
    typeof usage?.output_tokens === 'number'
      ? usage.output_tokens
      : typeof usage?.['usage.output_tokens'] === 'number'
        ? usage['usage.output_tokens']
        : null
  const inputTokens =
    typeof usage?.input_tokens === 'number'
      ? usage.input_tokens
      : typeof usage?.['usage.input_tokens'] === 'number'
        ? usage['usage.input_tokens']
        : null
  const hasUsage = inputTokens !== null || outputTokens !== null
  const hasStop = turn.stopReason != null

  if (!hasUsage && !hasStop) return null

  return (
    <MarkerRow marker="·" tone="muted">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-wider text-muted">
        {hasStop ? <span>stop: {turn.stopReason}</span> : null}
        {inputTokens !== null ? <span>in: {inputTokens}</span> : null}
        {outputTokens !== null ? <span>out: {outputTokens}</span> : null}
      </div>
    </MarkerRow>
  )
})

// ---------------------------------------------------------------------------
// Lazy entry mounting — the key to rendering fat conversations.
// ---------------------------------------------------------------------------
//
// Problem: a resumed session can have 200+ entries. Mounting all of them
// at once means 200 ReactMarkdown parses + CodeBlock syntax highlights
// in a single blocking render pass. That's multiple seconds of frozen UI,
// and the DOM ends up with thousands of nodes the browser has to lay out
// even though the user only sees the bottom ~20 entries.
//
// Solution: entries in the last EAGER_TAIL positions render immediately
// (they're in/near the viewport). Everything above starts as a thin
// placeholder div. An IntersectionObserver watches each placeholder and
// swaps in the real content when the user scrolls up to it. Once
// mounted, the entry stays mounted forever — React.memo keeps
// subsequent re-renders free, and we avoid the re-parse cost that full
// virtualization (unmount→remount on scroll) would cause.
//
// Why not full virtualization (react-window / tanstack-virtual):
//   - Our entry count is low hundreds, not tens of thousands.
//   - Virtualization unmounts rows that scroll out of view. Re-mounting
//     means re-parsing markdown (React.memo doesn't survive unmount).
//     We'd need a separate parsed-output cache. Complexity for no gain.
//   - Variable row heights (user prompt = 1 line, assistant with code
//     blocks = 500px+) make fixed-size virtualizers useless and
//     measured-height virtualizers finicky.
//   - The streaming row at the bottom grows continuously during
//     generation. Virtualizers don't handle a row whose height changes
//     every frame well.
//
// The EAGER_TAIL count is generous: 30 entries covers roughly 2-3
// screenfuls so the user never sees a placeholder flash on initial
// load or on tab-switch restore. Scrolling up past the eager zone
// triggers lazy mount with a 200px rootMargin (entries mount one
// screenful before they're visible), so the user never sees the swap.

const EAGER_TAIL = 30

/**
 * Wraps a single feed entry. If `eager` is true, renders children
 * immediately. Otherwise, renders a placeholder and waits for the
 * IntersectionObserver to fire before mounting the real content.
 *
 * Once mounted, stays mounted permanently — the `mounted` state only
 * transitions false→true, never back. This is load-bearing: unmounting
 * would discard React.memo's cached render tree and force a full
 * re-parse of the entry's markdown on the next scroll-into-view.
 */
const LazyEntry = memo(function LazyEntry({
  eager,
  suspended = false,
  scrollerRef,
  children,
}: {
  eager: boolean
  // True while the owning session is in a bootstrap burst. Suspends
  // observer attachment so 200 placeholders don't all mount at once
  // during a resume replay. Feed re-enables by flipping this back to
  // false after the bootstrap debounce clears (see Feed's
  // prevBootstrappingRef pin-once effect for the scroll pairing).
  suspended?: boolean
  scrollerRef: React.RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const [mounted, setMounted] = useState(eager)
  const placeholderRef = useRef<HTMLDivElement>(null)

  // If this entry starts lazy but later falls into the eager zone
  // (e.g. entries above it were filtered out, shrinking the list),
  // mount it immediately.
  useEffect(() => {
    if (eager && !mounted) setMounted(true)
  }, [eager, mounted])

  useEffect(() => {
    if (mounted) return
    // While the owning session is in a bootstrap burst, don't attach
    // the observer. Without this guard a resume replay pins to the
    // bottom and every placeholder within rootMargin flips mounted in
    // the same render — a cascade that's the actual "scrolling
    // through the whole conversation" symptom. Once the parent clears
    // `suspended`, Feed's pin-once effect lands us at the bottom and
    // normal scroll-triggered mounts take over from there.
    if (suspended) return
    const el = placeholderRef.current
    if (!el) return

    // Use the scroll container as the intersection root so the
    // observer fires relative to the visible scroll area, not the
    // document viewport. rootMargin adds 200px of lookahead above
    // the viewport so entries mount before the user scrolls to them
    // — no visible placeholder flash.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMounted(true)
          observer.disconnect()
        }
      },
      { root: scrollerRef.current, rootMargin: '200px 0px 200px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [mounted, suspended, scrollerRef])

  if (!mounted) {
    // Placeholder: a fixed-height div that approximates a typical
    // entry. The exact height doesn't matter much — it just needs to
    // be non-zero so the scroll container has enough height for the
    // IntersectionObserver to fire as the user scrolls. Once the real
    // content mounts, it takes its natural height and the scrollbar
    // adjusts. The 48px estimate is conservative (a single-line tool
    // result or system row). Taller entries will cause a small layout
    // shift on mount, but that happens off-screen (200px above the
    // viewport) so the user never sees it.
    return <div ref={placeholderRef} className="min-h-[48px]" />
  }

  return <>{children}</>
})

// Memoized: entry objects are stable across store updates (we append,
// never mutate), so shallow compare by entry reference skips re-render
// for every row that didn't itself change.
const EntryRow = memo(function EntryRow({ entry }: { entry: Entry }) {
  if (isCompactBoundaryEntry(entry)) {
    return <CompactBoundaryRow />
  }
  if (isCompactSummaryEntry(entry)) {
    return <CompactSummaryRow entry={entry} />
  }
  if (isConversationEntry(entry)) {
    return <ConversationRow entry={entry} />
  }
  return <SystemRow entry={entry} />
})

const ConversationRow = memo(function ConversationRow({
  entry,
}: {
  entry: ConversationEntry
}) {
  const role = entry.message.role
  const content = entry.message.content

  // Simple string content — render as a single marker + text line.
  // For role==='user' this IS a real user prompt (no tool_result can
  // appear here because tool_results are always block-form), so this
  // is the one place a top-level UserBand is correct.
  if (typeof content === 'string') {
    if (role === 'user') {
      return (
        <UserBand>
          <MarkerRow marker="❯">
            <TextProse text={content} />
          </MarkerRow>
        </UserBand>
      )
    }
    return (
      <MarkerRow marker="⏺">
        <TextProse text={content} />
      </MarkerRow>
    )
  }

  if (!Array.isArray(content)) return null

  // Multi-block content — render each block with its own layout.
  //
  // CRITICAL: we do NOT wrap this whole row in a UserBand even when
  // role === 'user'. That's because tool_result blocks ride inside
  // user-role messages (Anthropic API shape: the user turn that follows
  // an assistant tool_use holds the tool_result), and painting the
  // user-prompt highlight behind tool output looks identical to saying
  // "this file read was a user prompt." Confusing and wrong.
  //
  // The band lives at the *block* level instead: Block() wraps text
  // blocks in a UserBand when role === 'user', and leaves every other
  // block type (tool_use, tool_result, thinking) visually untouched.
  return (
    <div className="flex flex-col gap-2">
      {content.map((block, i) => (
        <Block key={i} block={block} role={role} />
      ))}
    </div>
  )
})

/**
 * UserBand — a horizontal highlight band that sits behind a *user
 * prompt* so real user turns are easy to spot when scanning a long
 * feed. Only ever wraps text content that originated as a user prompt.
 * Never wraps tool_result output (even though tool_result blocks live
 * under role='user' on the wire) — see the comment in ConversationRow.
 *
 * Why negative horizontal margin + matching padding:
 *   Feed rows sit inside a `px-8` centered column. If we just slapped
 *   bg-user-bg on the row, the highlight would be narrower than the
 *   column's gutters and look like a tight card. Pulling the band out
 *   to -mx-8 and compensating with px-8 makes the fill edge-to-edge
 *   within the column while keeping the text at its original x.
 *   gap-4 on the parent handles vertical separation between bands.
 */
function UserBand({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-user-bg -mx-8 px-8 py-3">
      {children}
    </div>
  )
}

// imageDataUrl moved to ../lib/helpers.ts.

const ImageBlockRow = memo(function ImageBlockRow({
  block,
  role,
}: {
  block: ContentBlock
  role: 'user' | 'assistant'
}) {
  const src = imageDataUrl(block)
  const mediaType =
    typeof (block as { source?: { media_type?: unknown } }).source?.media_type === 'string'
      ? (block as { source: { media_type: string } }).source.media_type
      : 'image'
  const alt = role === 'user' ? 'Pasted image' : 'Image'
  const row = (
    <MarkerRow marker={role === 'user' ? '❯' : '⏺'}>
      <div>
        {src ? (
          <img
            src={src}
            alt={alt}
            title={mediaType}
            className="max-h-[28rem] max-w-full rounded border border-border object-contain bg-surface"
          />
        ) : (
          <div className="text-muted text-[11px] uppercase tracking-wider">
            image
          </div>
        )}
      </div>
    </MarkerRow>
  )
  return role === 'user' ? <UserBand>{row}</UserBand> : row
})

const CompactBoundaryRow = memo(function CompactBoundaryRow() {
  return (
    <MarkerRow marker="·" tone="muted">
      <div className="text-[11px] uppercase tracking-wider text-muted">
        Conversation compacted
      </div>
    </MarkerRow>
  )
})

const CompactSummaryRow = memo(function CompactSummaryRow({
  entry,
}: {
  entry: CompactSummaryEntry
}) {
  const [expanded, setExpanded] = useState(false)
  const text = useMemo(() => compactSummaryText(entry), [entry])
  const compact = text.length > 2400 || text.split('\n').length > 24
  const visibleText = compact && !expanded ? truncateCompactSummary(text) : text

  return (
    <div className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-2 flex items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-wider text-accent font-semibold">
          Conversation Summary
        </div>
        {compact && (
          <button
            type="button"
            onClick={() => setExpanded(prev => !prev)}
            className="text-[11px] font-code text-muted hover:text-ink transition-colors"
          >
            {expanded ? 'collapse' : 'expand'}
          </button>
        )}
      </div>
      <div className="px-4 py-3">
        <TextProse text={visibleText} />
      </div>
    </div>
  )
})

// compactSummaryText + truncateCompactSummary moved to
// ../lib/helpers.ts. See those for the thinking-block + two-cap
// truncation rationale.

/**
 * Background band for tool output (Read, Grep, Edit results).
 * Subtler than UserBand — a faint step away from canvas that groups
 * tool output visually without competing with user turns or assistant
 * text. Same edge-to-edge trick as UserBand.
 */
function ToolBand({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-tool-bg -mx-8 px-8 py-2">
      {children}
    </div>
  )
}

// MarkerRow moved to ./MarkerRow.tsx — the `⏺`/`❯`/`⎿` layout primitive
// is now a shared module since features/git/ui/GitRows also imports it.
// Feed itself still imports MarkerRow from the new location at the top.

/* ---------- Block dispatcher ---------- */

// Memoized: blocks inside an assistant/user message are stable objects —
// the entry never mutates, so block identity is a perfect memo key.
const Block = memo(function Block({
  block,
  role,
}: {
  block: ContentBlock
  role: 'user' | 'assistant'
}) {
  const currentProvider = useContext(ProviderContext)
  const toolUseIndex = useContext(ToolUseIndexContext)
  const toolResultIndex = useContext(ToolResultIndexContext)
  const customRendering = useAppStore(state => state.settings.customRendering)
  switch (block.type) {
    case 'text': {
      // Only text blocks under a user role represent an actual user
      // prompt. A sibling tool_result block in the same message is
      // NOT a user prompt (it's tool output), and must not get the
      // highlight — that's why the band lives here and not around
      // the whole ConversationRow.
      const row = (
        <MarkerRow marker={role === 'user' ? '❯' : '⏺'}>
          <TextProse text={(block as { text: string }).text} />
        </MarkerRow>
      )
      return role === 'user' ? <UserBand>{row}</UserBand> : row
    }
    case 'thinking': {
      // Persisted thinking block. Anthropic strips the plaintext from
      // the final message (only `signature` ciphertext survives), so
      // text is ALMOST ALWAYS empty in committed transcripts. Old
      // behaviour was to render a placeholder `∴ Thinking` row; now
      // we render nothing and let the WorkIndicator (while live) and
      // the absence of content (after the fact) speak for themselves.
      //
      // Non-empty thinking on a committed block does still exist
      // (older sessions, non-Opus-4 models, synthetic entries). Keep
      // the expandable surface for those — aligned with the live
      // branch above, `<details>` closed by default.
      //
      // See docs/superpowers/plans/2026-04-18-thinking-indicator-rework.md.
      const text = (block as { thinking?: string }).thinking ?? ''
      if (!text) return null
      return (
        <MarkerRow marker="⏺" tone="muted">
          <details className="text-muted text-[12px]">
            <summary className="cursor-pointer select-none italic">
              ∴ Thinking
              <span className="ml-2 not-italic text-ink-dim opacity-70">
                (click to expand)
              </span>
            </summary>
            <div className="mt-1.5 text-ink-dim opacity-80">
              <TextProse text={text} />
            </div>
          </details>
        </MarkerRow>
      )
    }
    case 'image': {
      return <ImageBlockRow block={block} role={role} />
    }
    case 'tool_use': {
      // Dispatch tool_use blocks to provider-specific row renderers.
      // Claude has rich renderers for Edit/MultiEdit/Write/TodoWrite;
      // codex uses a generic CodexToolRow for now (will grow per-tool
      // renderers as we learn codex's tool shapes from recordings).
      const tu = block as ToolUseBlock

      // Custom rendering: intercept shell/bash invocations that are
      // recognized git commands and render them as a purpose-built
      // widget. Claude's tool name is 'Bash'; Codex's is
      // 'exec_command' (the function-call name). Both carry the
      // command string via extractToolCommand.
      //
      // We render on the tool_use row. The paired result block is
      // looked up from the reverse index; if not yet present (result
      // hasn't arrived), the widget shows a "running…" placeholder
      // sourced purely from the command. The companion tool_result
      // block is suppressed below so the widget is the single
      // surface for this command.
      if (
        customRendering
        && (tu.name === 'Bash' || tu.name === 'exec_command')
      ) {
        const cmd = extractToolCommand(tu)
        const intent = detectGitIntent(cmd)
        if (intent && cmd) {
          const paired = toolResultIndex.get(tu.id)
          const output = paired ? toolResultText(paired) : ''
          return (
            <ToolBand>
              <GitCardRow intent={intent} output={output} />
            </ToolBand>
          )
        }
      }

      if (currentProvider === 'codex') {
        return <CodexToolRow block={tu} />
      }
      // Claude provider — dispatch by tool name.
      switch (tu.name) {
        case 'Edit':
          return <ToolBand><EditRow block={tu} /></ToolBand>
        case 'MultiEdit':
          return <ToolBand><MultiEditRow block={tu} /></ToolBand>
        case 'Write':
          return <ToolBand><WriteRow block={tu} /></ToolBand>
        case 'TodoWrite':
          return <TodoRow block={tu} />
        default:
          return <ToolUseRow block={tu} />
      }
    }
    case 'tool_result': {
      const tr = block as ToolResultBlock
      // When custom rendering captured this result's source tool as
      // a git command, the tool_use row already rendered the widget
      // and consumed the output. Render nothing here so the output
      // doesn't duplicate below the card.
      if (customRendering) {
        const sourceTu = toolUseIndex.get(tr.tool_use_id)
        if (
          sourceTu
          && (sourceTu.name === 'Bash' || sourceTu.name === 'exec_command')
          && detectGitIntent(extractToolCommand(sourceTu))
        ) {
          return null
        }
      }
      if (currentProvider === 'codex') {
        return <CodexToolResultRow block={tr} />
      }
      return <ToolResultRow block={tr} />
    }
    default:
      return (
        <MarkerRow marker="⏺" tone="muted">
          <div className="text-muted text-[11px] uppercase tracking-wider">
            {block.type}
          </div>
        </MarkerRow>
      )
  }
})

/* ---------- Text prose ---------- */

// Memoized: `text` is a plain string, so shallow compare is exact
// equality. This is the single biggest win in the file — markdown
// parsing is the expensive part, and by memoing on the text string we
// skip the unified pipeline entirely for every row that didn't change.
const TextProse = memo(function TextProse({ text }: { text: string }) {
  if (!text) return null
  return (
    <div className="prose-theme text-ink text-[13px] leading-[1.65]">
      <ReactMarkdown
        remarkPlugins={COMPLETED_REMARK}
        components={MARKDOWN_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

/**
 * Same visual surface as TextProse, but uses the streaming plugin set
 * (remark-breaks added) so hard newlines from the screen buffer survive
 * as <br> in the rendered output. See the comment on STREAMING_REMARK
 * above for the full reasoning.
 *
 * Memoized by text string too: CC's screen re-renders fire at ~60Hz
 * and the extracted assistant text is usually identical between frames
 * (CC is redrawing chrome, not changing content). Memoing here turns
 * those redundant frames into free ones.
 */
const StreamingProse = memo(function StreamingProse({
  text,
}: {
  text: string
}) {
  if (!text) return null
  return (
    <div className="prose-theme text-ink text-[13px] leading-[1.65]">
      <ReactMarkdown
        remarkPlugins={STREAMING_REMARK}
        components={MARKDOWN_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

/* ---------- Tool use: "⏺ Bash  ⎿ $ command" ---------- */

// Bash-command display cap, mirroring claude-code's Ink UI:
//   claude-code-src/full/tools/BashTool/UI.tsx
//     const MAX_COMMAND_DISPLAY_LINES = 2
//     const MAX_COMMAND_DISPLAY_CHARS = 160
// Long / multiline invocations truncate with a trailing `…`. The
// whole command remains in the transcript; the collapse is purely
// a density choice so a 20-line heredoc doesn't push the next
// assistant message below the fold.
// MAX_COMMAND_DISPLAY_* constants + truncateBashCommand moved to
// ../lib/helpers.ts.

const ToolUseRow = memo(function ToolUseRow({ block }: { block: ToolUseBlock }) {
  // Extract the command / description for Bash-like tools. For tools
  // without a `command` field we fall back to stringified input.
  const input = block.input as Record<string, unknown> | undefined
  const rawHeadline = typeof input?.command === 'string'
    ? input.command
    : typeof input?.description === 'string'
      ? input.description
      : typeof input?.path === 'string'
        ? input.path
        : null

  // Bash commands get the 2-line / 160-char cap claude-code's Ink UI
  // enforces. `description` and `path` headlines are already one-line-
  // ish so we only truncate when the headline came from `command`.
  const headline = (() => {
    if (!rawHeadline) return null
    if (block.name === 'Bash' && typeof input?.command === 'string') {
      return truncateBashCommand(input.command)
    }
    return rawHeadline
  })()

  return (
    <MarkerRow marker="⏺">
      <div>
        <div className="text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">{block.name}</span>
        </div>
        {headline && (
          <MarkerRow marker="⎿" tone="muted">
            <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
              {headline}
            </pre>
          </MarkerRow>
        )}
      </div>
    </MarkerRow>
  )
})

/* ---------- Tool result: "⎿  (lines of output)" ---------- */

/**
 * Look at the tool_use this result came from (via the feed-level
 * index in context) and decide how to render the result:
 *
 *   Read → strip the "N→" line-number prefix CC's Read tool emits,
 *          and render the contents as a preformatted code slab. We
 *          deliberately skip markdown parsing here because source
 *          code frequently contains triple-backticks and unbalanced
 *          emphasis that would wreck the markdown AST. For full
 *          syntax highlighting later we can feed the stripped text
 *          through highlight.js directly.
 *
 *   Edit / MultiEdit / Write → the diff/content already rendered on
 *          the preceding tool_use row tells the story. The terse
 *          "has been updated successfully" message is pure noise
 *          next to it; suppress for non-errors.
 *
 *   everything else (Bash, Glob, Grep, …) → keep the existing
 *          plain-pre rendering. The content IS the interesting part
 *          for those tools.
 */
const ToolResultRow = memo(function ToolResultRow({
  block,
}: {
  block: ToolResultBlock
}) {
  const toolUseIndex = useContext(ToolUseIndexContext)
  const codeContext = useContext(CodeRenderContext)
  const sourceTool = toolUseIndex.get(block.tool_use_id)?.name

  const text =
    typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content
            .map(c => (typeof c === 'string' ? c : c.text ?? ''))
            .join('\n')
        : String(block.content)

  const isError = block.is_error === true
  const trimmed = text.replace(/\s+$/, '')

  // File-write tools AND TodoWrite: the rendered diff/content/checklist
  // on the preceding tool_use row already tells the story. The result
  // in all four cases is a stub success string that would just clutter
  // the feed. Errors still fall through to the normal result renderer
  // so failures remain visible.
  if (
    !isError &&
    (sourceTool === 'Edit' ||
      sourceTool === 'MultiEdit' ||
      sourceTool === 'Write' ||
      sourceTool === 'TodoWrite')
  ) {
    return null
  }

  // Read tool result — show a one-line summary only, not the file
  // contents. Mirrors claude-code-src/full/tools/FileReadTool/UI.tsx
  // `renderToolResultMessage` which renders "Read <N> lines" at
  // height={1} and never echoes the file bytes into the feed. The
  // user already knows which file was read (it's on the tool-use
  // row); dumping its contents below pushes the next assistant
  // message off-screen for no gain.
  //
  // A click-to-expand <details> keeps the raw content one
  // interaction away for when you actually need it (debugging,
  // code review). Syntax highlighting happens inside CodeBlock
  // only when expanded.
  if (sourceTool === 'Read' && !isError) {
    const stripped = stripLineNumberPrefix(trimmed)
    const numLines = stripped ? stripped.split('\n').length : 0
    const sourceInput = toolUseIndex.get(block.tool_use_id)?.input as
      | Record<string, unknown>
      | undefined
    const filePath =
      typeof sourceInput?.file_path === 'string'
        ? sourceInput.file_path
        : typeof sourceInput?.path === 'string'
          ? sourceInput.path
          : null
    return (
      <MarkerRow marker="⎿" tone="muted">
        <details className="text-[12px] leading-[1.55] text-ink-dim">
          <summary className="cursor-pointer select-none">
            Read <span className="text-ink font-semibold">{numLines}</span>{' '}
            {numLines === 1 ? 'line' : 'lines'}
          </summary>
          <div className="mt-2">
            <CodeBlock
              code={stripped}
              path={filePath}
              workspaceRoot={codeContext.workspaceRoot}
              codeId={`read:${block.tool_use_id}`}
              engine="monaco"
              allowAutoDetect
            />
          </div>
        </details>
      </MarkerRow>
    )
  }

  // Grep tool result: render with CodeBlock so results get syntax
  // highlighting based on the file pattern / path. Grep output is
  // already formatted text but benefits from language-aware coloring.
  if (sourceTool === 'Grep' && !isError) {
    const sourceInput = toolUseIndex.get(block.tool_use_id)?.input as
      | Record<string, unknown>
      | undefined
    const filePath =
      typeof sourceInput?.path === 'string'
        ? sourceInput.path
        : null
    return (
      <ToolBand>
        <MarkerRow marker="⎿" tone="muted">
          <CodeBlock
            code={trimmed}
            path={filePath}
            workspaceRoot={codeContext.workspaceRoot}
            codeId={`grep:${block.tool_use_id}`}
            engine="monaco"
            allowAutoDetect
          />
        </MarkerRow>
      </ToolBand>
    )
  }

  // Everything else — Bash, Glob, LS, tool errors — truncates to the
  // first few lines and offers a click-to-expand for the rest. Mirrors
  // claude-code's OutputLine + renderTruncatedContent (MAX_LINES_TO_SHOW
  // = 3). The collapsed view keeps the feed dense so a long `find .`
  // or noisy test run doesn't push the assistant's next message off.
  return <TruncatedOutputRow content={trimmed} isError={isError} />
})

// MAX_LINES_TO_SHOW in claude-code-src. Hoisted so the memo'd row
// component doesn't re-create the constant every render.
const RESULT_MAX_LINES = 3

function TruncatedOutputRow({
  content,
  isError,
}: {
  content: string
  isError: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const lines = content.length === 0 ? [] : content.split('\n')
  const needsTruncation = lines.length > RESULT_MAX_LINES
  const shown = expanded || !needsTruncation
    ? content
    : lines.slice(0, RESULT_MAX_LINES).join('\n')
  const hiddenCount = needsTruncation ? lines.length - RESULT_MAX_LINES : 0
  return (
    <MarkerRow marker="⎿" tone="muted">
      <pre
        className={`
          font-code text-[12px] leading-[1.55] whitespace-pre-wrap break-words m-0
          ${expanded ? 'max-h-[360px] overflow-auto' : ''}
          ${isError ? 'text-danger' : 'text-ink-dim'}
        `}
      >
        {shown}
      </pre>
      {needsTruncation && (
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="mt-1 text-[11px] text-muted hover:text-ink cursor-pointer"
        >
          {expanded
            ? 'collapse'
            : `… +${hiddenCount} ${hiddenCount === 1 ? 'line' : 'lines'} (click to expand)`}
        </button>
      )}
    </MarkerRow>
  )
}

// stripLineNumberPrefix moved to ../lib/helpers.ts — see there for
// the "CC emits 'n\t<line>' in Read tool results" rationale.

/* ---------- System row (hidden by default; shown when toggled on) ---------- */

const SystemRow = memo(function SystemRow({ entry }: { entry: Entry }) {
  const label =
    entry.type === 'attachment'
      ? attachmentLabel(entry)
      : entry.type === 'permission-mode'
        ? `permission mode: ${(entry as { permissionMode?: string }).permissionMode ?? '?'}`
        : entry.type === 'file-history-snapshot'
          ? 'file history snapshot'
          : entry.type
  return (
    <MarkerRow marker="·" tone="muted">
      <div className="text-[11px] text-muted leading-[1.65] opacity-60">
        {label}
      </div>
    </MarkerRow>
  )
})

// attachmentLabel moved to ../lib/helpers.ts.

/* ---------- Streaming row — REMOVED ----------
 *
 * The render-time regex extractor over the raw TUI screen used to
 * live here (`StreamingRow` + `isStaleStreamingExtract` helpers).
 * Its removal is the structural fix for the "double-render last
 * message on resume" and "previous assistant text rendered below
 * new user prompt after submit" bugs.
 *
 * Rationale: two producers were competing for the same feed slot —
 * `<EntryRow>` (authoritative, from JSONL) and `<StreamingRow>`
 * (inferred, regex over raw TUI). Dropping the screen scraper leaves
 * exactly one owner for live text: `<SemanticStreamingTurn>`, fed by
 * the headless packages' semantic channel. Screen-derived live text
 * still works — the packages publish it as semantic deltas tagged
 * `source: 'screen'`, gated by a baseline so they can't leak the
 * previous turn's buffered bytes as the first delta of a new turn.
 */

/* ---------- Activity indicator REMOVED — replaced by <WorkIndicator> ----------
 *
 * The local `ActivityIndicator` function used to live here. It was the
 * "agent is working" pulse-dot + verb row, rendered at the foot of the
 * feed and gated on `semanticTurn == null`. That gate was the bug: the
 * indicator vanished the moment a semantic turn mounted, leaving a
 * visual blind spot during tool execution and the mid-turn gaps
 * between blocks.
 *
 * The replacement is `<WorkIndicator>` in `./WorkIndicator.tsx`, driven
 * by the adapter-derived `runtime.streamPhase` field instead of the
 * TUI spinner verb. See
 * docs/superpowers/plans/2026-04-18-thinking-indicator-rework.md and
 * docs/superpowers/plans/2026-04-18-thinking-phase-in-headless.md.
 *
 * The duplicate component at `src/shared/ui/ActivityIndicator.tsx` is
 * also being removed in the same pass; it was dead code (exported but
 * never imported).
 */
