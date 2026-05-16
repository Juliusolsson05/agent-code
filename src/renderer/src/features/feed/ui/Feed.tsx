import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
  type Entry,
} from '@shared/types/transcript'

import type {
  SemanticLiveTurn,
  StreamPhase,
} from '@renderer/workspace/workspaceState'
import { WorkIndicator } from '@renderer/features/feed/WorkIndicator'
import { toolHintFromTurn } from '@renderer/features/feed/workIndicatorHints'
import {
  ProviderContext,
  ToolUseIndexContext,
  ToolResultIndexContext,
  CodeRenderContext,
} from '@renderer/features/feed/context'
import {
  type AgentProvider,
  type ScrollInfo,
  type VisibleDecision,
  type DebugVisibleRow,
} from '@renderer/features/feed/types'
import { scrollPositions } from '@renderer/features/feed/scroll'
import {
  buildToolUseIndex,
  buildToolResultIndex,
  debugKeyForEntry,
  debugLabelForEntry,
} from '@renderer/features/feed/lib/helpers'
import { SemanticStreamingTurn } from '@renderer/features/feed/ui/semantic'
import {
  EAGER_TAIL,
  EntryRow,
  LazyEntry,
} from '@renderer/features/feed/ui/rows'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import * as perf from '@renderer/performance/client'

// Re-export — many external callers import these types from Feed
// directly rather than reaching into ../types/../context. Keep the
// alias stable until the sweep is over.
export type { AgentProvider, ScrollInfo } from '@renderer/features/feed/types'
export { CodeRenderContext } from '@renderer/features/feed/context'

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
  codeBlockSelectedId = null,
  workspaceRoot = null,
  onScrollInfo,
  onUserEngagement,
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

  // Copy Code Block picker — highlight + scroll the selected block.
  //
  // WHY a separate effect from the assistant-entry one above, and why
  // the outline is applied imperatively here rather than as a JSX
  // class: the assistant picker highlights an ENTRY, and Feed already
  // renders a wrapper <div data-entry-uuid> per entry that it can add
  // an outline class to in JSX. A code block is a `CodeBlock` buried
  // deep inside rendered markdown / tool rows — there is no per-block
  // wrapper Feed controls. So we locate the block by its
  // `data-code-block-id` and toggle the outline classes on the node
  // directly; the cleanup removes them.
  //
  // The outline class list is the SAME tokens the entry picker uses
  // (line ~881) — keeping them identical means Tailwind's static
  // scan already emits the CSS, so `classList.add` is safe.
  //
  // Shares `scrollAnimFrameRef` with the assistant-picker scroll so a
  // tween from one picker is cancelled if the other starts; only one
  // picker is ever active at a time, so they never genuinely race.
  useEffect(() => {
    if (!codeBlockSelectedId) return
    const root = scrollerRef.current
    if (!root) return
    const target = root.querySelector(
      `[data-code-block-id="${codeBlockSelectedId}"]`,
    ) as HTMLElement | null
    if (!target) return

    const outline = ['outline', 'outline-2', 'outline-accent', 'outline-offset-2']
    target.classList.add(...outline)

    // Center the block in the scroller — same rAF tween as the
    // assistant-picker scroll effect (native smooth-scroll fought the
    // feed's own scroll listener; see the long note on that effect).
    const targetCenter = target.offsetTop + target.offsetHeight / 2
    const desired = targetCenter - root.clientHeight / 2
    const maxScroll = root.scrollHeight - root.clientHeight
    const to = Math.max(0, Math.min(maxScroll, desired))
    const from = root.scrollTop
    const distance = to - from
    if (Math.abs(distance) >= 1) {
      if (scrollAnimFrameRef.current !== null) {
        cancelAnimationFrame(scrollAnimFrameRef.current)
        scrollAnimFrameRef.current = null
      }
      const duration = 180
      const startTime = performance.now()
      const ease = (t: number) => 1 - Math.pow(1 - t, 3)
      const step = (now: number) => {
        const t = Math.min(1, (now - startTime) / duration)
        root.scrollTop = from + distance * ease(t)
        if (t < 1) {
          scrollAnimFrameRef.current = requestAnimationFrame(step)
        } else {
          scrollAnimFrameRef.current = null
        }
      }
      scrollAnimFrameRef.current = requestAnimationFrame(step)
    }

    return () => {
      target.classList.remove(...outline)
      if (scrollAnimFrameRef.current !== null) {
        cancelAnimationFrame(scrollAnimFrameRef.current)
        scrollAnimFrameRef.current = null
      }
    }
  }, [codeBlockSelectedId])

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
  const visibleDecisions = useMemo<VisibleDecision[]>(() => {
    const startedAt = performance.now()
    const decisions = entries.map((entry, index) => {
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
      })
    const durationMs = performance.now() - startedAt
    if (durationMs >= 10 || entries.length >= 500) {
      perf.metric('feed.visibleDecisions.build', durationMs, 'sample', {
        sessionId,
        entries: entries.length,
        decisions: decisions.length,
      })
    }
    return decisions
  }, [entries, sessionId])

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
  // time. When those props are present, return them directly; do not
  // rebuild the fallback maps from entries on every append.
  const toolUseIndex = useMemo(
    () => toolUseIndexProp ?? buildToolUseIndex(entries),
    [entries, toolUseIndexProp],
  )
  const toolResultIndex = useMemo(
    () => toolResultIndexProp ?? buildToolResultIndex(entries),
    [entries, toolResultIndexProp],
  )

  const hasSemanticStreaming = renderedSemanticTurn !== null
  const shouldShowWorkIndicator = streamPhase !== 'idle'

  const renderedRows = useMemo<DebugVisibleRow[]>(() => {
    const startedAt = performance.now()
    if (visible.length === 0 && !hasSemanticStreaming) {
      const rows: DebugVisibleRow[] = [{
        key: 'empty',
        slot: 'empty',
        label: provider === 'codex' ? 'waiting for Codex…' : 'waiting for Claude Code…',
      }]
      perf.metric('feed.renderedRows.build', performance.now() - startedAt, 'sample', {
        sessionId,
        entries: entries.length,
        visible: visible.length,
        rows: rows.length,
      })
      return rows
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
    const durationMs = performance.now() - startedAt
    if (durationMs >= 10 || entries.length >= 500) {
      perf.metric('feed.renderedRows.build', durationMs, 'sample', {
        sessionId,
        entries: entries.length,
        visible: visible.length,
        rows: rows.length,
        hasSemanticStreaming,
      })
    }
    return rows
  }, [
    entries.length,
    hasSemanticStreaming,
    provider,
    renderedSemanticTurn,
    sessionId,
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
    // Empty-feed branch: no committed entries yet AND no live
    // semantic turn. Show the WorkIndicator if the stream phase is
    // non-idle — the placeholder-only render used to swallow
    // the indicator during `submitting` / `requesting` / early
    // `thinking`, so a fresh submit looked like a silent stall
    // until the first delta landed. Reuse the same positioning the
    // non-empty branch uses (WorkIndicator at the natural
    // composer-adjacent bottom), wrapped here in a column flex so
    // the placeholder text stays centered above it when idle.
    return (
      <div className="h-full flex flex-col">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-muted text-[12px]">
            {provider === 'codex' ? 'waiting for Codex…' : 'waiting for Claude Code…'}
          </div>
        </div>
        {shouldShowWorkIndicator && (
          <div className="flex-shrink-0 px-8 pb-6">
            <WorkIndicator
              phase={streamPhase}
              toolName={streamPhasePendingToolName}
              toolHint={toolHintFromTurn(semanticTurn, streamPhasePendingToolUseId)}
              turnStartedAt={turnStartedAt}
            />
          </div>
        )}
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
        onWheel={() => {
          onUserEngagement?.()
        }}
        onPointerDown={() => {
          onUserEngagement?.()
        }}
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
            <SemanticStreamingTurn
              turn={renderedSemanticTurn}
              committedEntries={entries}
            />
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

// Semantic streaming section moved to ./semantic/ — see those files for the
// full rationale on each component. Feed.tsx now imports only
// SemanticStreamingTurn (the orchestrator) via ./semantic/index.ts.
// SemanticTaskSummary + SemanticTurnFooter were deleted in the
// 2026-04-18 thinking-indicator rework (dead code; see the comment
// inside StreamingTurn.tsx for why).

// ---------------------------------------------------------------------------
// Row components moved to ./rows/
// ---------------------------------------------------------------------------
//
// The entire row surface (LazyEntry, EntryRow, ConversationRow, Block,
// ImageBlockRow, CompactBoundaryRow, CompactSummaryRow, SystemRow,
// ToolUseRow, ToolResultRow, TruncatedOutputRow, UserBand, ToolBand,
// plus the EAGER_TAIL constant) moved to ./rows/. Each component lives
// in its own file, and the long WHY comments (lazy mount rationale,
// the "CRITICAL: don't wrap tool_results in UserBand" gotcha, the
// Read/Grep/Edit result-rendering taxonomy, the bash headline cap,
// etc.) travelled with the code. Feed.tsx now imports EAGER_TAIL +
// EntryRow + LazyEntry through ./rows/index.ts — the rest are internal
// to the rows tree. The "Streaming row REMOVED" + "Activity indicator
// REMOVED" rationale blocks that used to live at the tail of this
// file are folded into ./semantic/StreamingTurn.tsx + ./WorkIndicator.tsx
// where those replacements actually live.
