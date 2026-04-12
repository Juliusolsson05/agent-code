import {
  createContext,
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
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

import { extractAssistantInProgress } from '../../../shared/parsers/extractAssistant'
import {
  EditRow,
  MultiEditRow,
  WriteRow,
  TodoRow,
} from './claude/ClaudeRows'
import { CodexToolRow } from './codex/CodexRows'
import {
  isConversationEntry,
  type ContentBlock,
  type ConversationEntry,
  type Entry,
  type ToolResultBlock,
  type ToolUseBlock,
} from '../../../shared/types/transcript'
import { CodeBlock } from '../code/CodeBlock'

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

// Plugin sets are defined at module scope because react-markdown v10 caches
// parse results keyed on plugin identity — passing fresh array literals on
// every parent render busts the cache and costs real frames.
//
// The two sets differ in ONE plugin:
//
//   COMPLETED_REMARK: just `remark-gfm`. Completed assistant text from the
//   JSONL is real markdown source with proper paragraph breaks, so
//   standard markdown rules apply.
//
//   STREAMING_REMARK: `remark-gfm` + `remark-breaks`. The streaming source
//   is CC's screen buffer — plain text stripped of ANSI. CC's Ink already
//   converted markdown syntax (** _ ` ```) to terminal attributes and
//   discarded the characters by the time it hits our buffer, so there's
//   no real markdown to parse. But single newlines are load-bearing in
//   the streaming text (each line is a genuine line, not a soft wrap),
//   and standard markdown collapses single newlines into soft wraps that
//   flow together as one paragraph. `remark-breaks` turns each hard
//   newline into a <br>, preserving the visual line layout. Without it,
//   a multi-line response like "There are 19 entries:\n  body.txt\n
//   claude-501\n…" would collapse into one blob.
//
// Rendering streaming through react-markdown instead of a raw <pre> also
// makes the typography match completed messages exactly: same font, size,
// line-height, paragraph rhythm. When the JSONL entry lands and the
// structured version takes over, the visual jump is minimal — just
// richer formatting on top of the same base layout.
const COMPLETED_REMARK = [remarkGfm]
const STREAMING_REMARK = [remarkGfm, remarkBreaks]
// -----------------------------------------------------------------------------
// Tool-use index: a map from tool_use_id → ToolUseBlock, built once per
// render pass over the entire feed. Used by ToolResultRow to look up
// "what tool produced this result" so it can pick a richer renderer for
// known tools (Read → syntax-highlighted code; Bash → plain pre; …).
//
// Why a side channel instead of pairing at the ConversationRow level:
//   tool_use blocks live in an ASSISTANT entry and tool_result blocks
//   live in the NEXT USER entry. ConversationRow only sees one entry at
//   a time, so it can't pair them structurally without reaching across
//   entries. We build the index at Feed level (where we DO have every
//   entry) and hand it to result rows via context so the memoed row
//   components don't need a new prop.
//
// Memo behavior: the map reference changes whenever `entries` changes,
// which invalidates useContext consumers. That's fine — rows that care
// about the map already re-render when entries grow, and rows that
// don't call useContext are unaffected. We do NOT include the map in
// row memo keys; equality on the map itself would be expensive and the
// interesting work (markdown parsing) is cached inside TextProse by
// text string, so repeat renders are cheap.
// -----------------------------------------------------------------------------

const ProviderContext = createContext<AgentProvider>('claude')
const ToolUseIndexContext = createContext<Map<string, ToolUseBlock>>(new Map())
export const CodeRenderContext = createContext<{
  sessionId: string
  workspaceRoot: string | null
}>({
  sessionId: '',
  workspaceRoot: null,
})

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

  // Fenced/indented code block → full CodeBlock with highlighting.
  // allowAutoDetect for unlabeled blocks restores the old
  // rehype-highlight detect:true behavior.
  return (
    <CodeBlock
      code={text}
      language={language}
      workspaceRoot={workspaceRoot}
      codeId={`${sessionId}:${text.slice(0, 24)}`}
      allowAutoDetect={!language}
    />
  )
}

const MARKDOWN_COMPONENTS: import('react-markdown').Options['components'] = {
  pre: MarkdownPre,
  code: MarkdownCode,
}

function buildToolUseIndex(entries: Entry[]): Map<string, ToolUseBlock> {
  const map = new Map<string, ToolUseBlock>()
  for (const e of entries) {
    if (!isConversationEntry(e)) continue
    const content = e.message.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b.type === 'tool_use') {
        const tu = b as ToolUseBlock
        map.set(tu.id, tu)
      }
    }
  }
  return map
}

/** Which agent provider this Feed is rendering for. Determines
 *  which row renderers are used for tool_use blocks. */
export type AgentProvider = 'claude' | 'codex'

type Props = {
  /** Session identity — used as the key for per-session scroll
   *  position persistence across Feed unmount/remount (tab switches).
   *  See `scrollPositions` below. */
  sessionId: string
  /** Which provider's row renderers to use. Default 'claude'. */
  provider?: AgentProvider
  entries: Entry[]
  /** Plain-text screen snapshot. Used for baseline comparison. */
  streamingScreen?: string | null
  /** Same screen with bold/italic cell attributes reconstructed as
   *  markdown. Used for the actual streaming card render. */
  streamingScreenMarkdown?: string | null
  streamingBaseline?: string | null
  /** Activity status detected from the screen buffer. Non-null when
   *  CC is actively working — carries the spinner verb text (e.g.
   *  "Cogitating…"). Used to show a working indicator at the bottom
   *  of the feed and to enrich the "thinking…" fallback in the
   *  streaming row with the actual verb CC is displaying. */
  activityStatus?: string | null
  showSystemEvents: boolean
  workspaceRoot?: string | null
}

// ---------------------------------------------------------------------------
// Per-session scroll position memory.
//
// When the user switches tabs, App.tsx unmounts the inactive tab's
// TileTree — and with it, every Feed inside. When they switch back,
// a fresh Feed mounts with a brand-new scroll container at scrollTop=0.
// Without intervention that snaps the viewport to the top (or to a
// weird "just after first paint" position), which the user rightly
// called out as "weird and stupid."
//
// The fix is to persist each Feed's scroll state OUTSIDE the React
// component tree so it survives unmount. A module-level Map keyed by
// sessionId is the simplest possible store: no re-renders, no store
// plumbing, no prop noise. We record (scrollTop + stickyBottom flag)
// on every scroll tick and read them back in a useLayoutEffect on
// mount to restore the viewport BEFORE the browser paints.
//
// Why not put this in SessionRuntime: scroll position is a pure UI
// concern — no IPC, no persistence across app restarts, no other
// consumer. Hoisting it into the runtime state would force Feed to
// take an extra prop (workspace or a setter) and would invalidate
// Feed's React.memo shallow-compare on every scroll tick because the
// runtime object reference would change. Module-level Map sidesteps
// both problems.
//
// The Map is not bounded — if a session is killed, its entry sticks
// around forever. That's fine: each entry is two numbers and a
// boolean, and the Map only grows by the count of sessions EVER
// opened in this browser process lifetime (which typically resets
// on Electron window reload). Adding a cleanup on session kill
// would be a minor optimization if that ever matters.
// ---------------------------------------------------------------------------
type ScrollPosition = {
  scrollTop: number
  stickyBottom: boolean
}
const scrollPositions = new Map<string, ScrollPosition>()

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
  streamingScreen,
  streamingScreenMarkdown,
  streamingBaseline,
  activityStatus,
  showSystemEvents,
  workspaceRoot = null,
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
    } else {
      // Case 3: restore exact position.
      el.scrollTop = saved.scrollTop
      stickyBottomRef.current = false
    }
  }, [sessionId])

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
      const gap = el.scrollHeight - (el.scrollTop + el.clientHeight)
      stickyBottomRef.current = gap < 48
      scrollPositions.set(sessionId, {
        scrollTop: el.scrollTop,
        stickyBottom: stickyBottomRef.current,
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [sessionId])

  // Auto-scroll on content changes, but ONLY when sticky. The effect
  // runs on every change that would grow the feed (a new entry) or
  // move the streaming tail (a new streamingScreen snapshot). If the
  // user is scrolled up, we skip — they're reading earlier content
  // and we don't want to yank them back.
  useEffect(() => {
    if (!stickyBottomRef.current) return
    // scrollTop = scrollHeight pins to bottom without the smooth-scroll
    // overshoot scrollIntoView sometimes produces. Direct, instant,
    // no animation frames.
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length, streamingScreen])

  // Visible entries = all entries if system events are shown, otherwise
  // skip attachment / permission-mode / file-history-snapshot AND
  // isMeta entries. isMeta entries are CC's system-injected user-role
  // messages: task-notification results from subagents, auto-continue
  // hints ("Continue from where you left off."), system-reminder
  // payloads, etc. They carry `isMeta: true` on the entry but pass
  // the isConversationEntry check because they have type='user' and
  // a real message object. Without this filter, a background agent's
  // completion notification would render as a full UserBand in the
  // feed with raw <task-notification> XML visible — exactly the bug
  // the user reported.
  const visible = showSystemEvents
    ? entries
    : entries.filter(e => {
        if (!isConversationEntry(e)) return false
        if ((e as unknown as { isMeta?: boolean }).isMeta === true) return false
        return true
      })

  // Index EVERY tool_use block (not just the visible set) so tool_result
  // lookups still resolve even when showSystemEvents is off and some
  // synthetic entries have been filtered out. The index is cheap to
  // build (single pass) and the resulting Map is handed to result rows
  // via context.
  const toolUseIndex = useMemo(() => buildToolUseIndex(entries), [entries])

  if (visible.length === 0 && !streamingScreen) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-muted text-[12px]">
          waiting for Claude Code…
        </div>
      </div>
    )
  }

  return (
    <ProviderContext.Provider value={provider}>
    <ToolUseIndexContext.Provider value={toolUseIndex}>
    <CodeRenderContext.Provider value={{ sessionId, workspaceRoot }}>
      <div
        ref={scrollerRef}
        className="h-full overflow-auto"
      >
        <div className="max-w-[880px] mx-auto px-8 pt-6 pb-8 flex flex-col gap-4">
          {visible.map((e, i) => {
            const key = (e as Entry).uuid ?? `i${i}`
            // The last EAGER_TAIL entries render immediately — they're
            // in or near the current viewport (the user sees the bottom
            // of the feed on load). Everything above starts as a
            // lightweight placeholder and mounts when the user scrolls
            // up to it. Once mounted, never unmounts — React.memo
            // keeps re-renders free and we avoid the re-parse cost
            // that virtualization (unmount→remount) would cause.
            const eager = i >= visible.length - EAGER_TAIL
            return (
              <LazyEntry key={key} eager={eager} scrollerRef={scrollerRef}>
                <EntryRow entry={e} />
              </LazyEntry>
            )
          })}
          {streamingScreen != null && (
            <StreamingRow
              screen={streamingScreen}
              screenMarkdown={streamingScreenMarkdown ?? streamingScreen}
              baseline={streamingBaseline ?? null}
              activityStatus={activityStatus ?? null}
            />
          )}
          {/* Activity indicator: shown when CC is working but the
              streaming row isn't active yet (e.g. the very start of a
              turn before awaitingAssistant flips, or during tool
              execution between JSONL entries). The streaming row
              handles its own "thinking…" state internally, so we only
              render this when the streaming row is absent. */}
          {streamingScreen == null && activityStatus && (
            <ActivityIndicator status={activityStatus} />
          )}
          <div ref={endRef} />
        </div>
      </div>
    </CodeRenderContext.Provider>
    </ToolUseIndexContext.Provider>
    </ProviderContext.Provider>
  )
}

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
  scrollerRef,
  children,
}: {
  eager: boolean
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
  }, [mounted, scrollerRef])

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

/* ---------- Marker layout primitives ---------- */

/**
 * The core layout: a fixed-width marker column + flex-1 content column
 * that enforces hanging indent. Used by every rendered block.
 */
export function MarkerRow({
  marker,
  tone = 'accent',
  children,
  indent = 0,
}: {
  marker: string
  tone?: 'accent' | 'muted' | 'ink'
  children: React.ReactNode
  indent?: number
}) {
  const toneClass =
    tone === 'accent' ? 'text-accent' : tone === 'muted' ? 'text-muted' : 'text-ink-dim'
  return (
    <div
      className="flex gap-2.5"
      style={indent ? { paddingLeft: `${indent * 22}px` } : undefined}
    >
      <span
        className={`${toneClass} flex-shrink-0 w-3 text-[13px] leading-[1.65] select-none`}
        aria-hidden="true"
      >
        {marker}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

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
    case 'thinking':
      // Thinking is usually noise — dim + collapsed behind a disclosure,
      // with the ⏺ marker so it sits in the assistant column rhythm.
      return (
        <MarkerRow marker="⏺" tone="muted">
          <details className="text-muted text-[12px]">
            <summary className="cursor-pointer select-none">thinking</summary>
            <pre className="mt-1.5 whitespace-pre-wrap break-words text-ink-dim text-[11.5px] leading-relaxed opacity-80">
              {(block as { thinking: string }).thinking}
            </pre>
          </details>
        </MarkerRow>
      )
    case 'tool_use': {
      // Dispatch tool_use blocks to provider-specific row renderers.
      // Claude has rich renderers for Edit/MultiEdit/Write/TodoWrite;
      // codex uses a generic CodexToolRow for now (will grow per-tool
      // renderers as we learn codex's tool shapes from recordings).
      const tu = block as ToolUseBlock
      if (currentProvider === 'codex') {
        return <CodexToolRow block={tu} />
      }
      // Claude provider — dispatch by tool name.
      switch (tu.name) {
        case 'Edit':
          return <EditRow block={tu} />
        case 'MultiEdit':
          return <MultiEditRow block={tu} />
        case 'Write':
          return <WriteRow block={tu} />
        case 'TodoWrite':
          return <TodoRow block={tu} />
        default:
          return <ToolUseRow block={tu} />
      }
    }
    case 'tool_result':
      return <ToolResultRow block={block as ToolResultBlock} />
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

const ToolUseRow = memo(function ToolUseRow({ block }: { block: ToolUseBlock }) {
  // Extract the command / description for Bash-like tools. For tools
  // without a `command` field we fall back to stringified input.
  const input = block.input as Record<string, unknown> | undefined
  const headline = typeof input?.command === 'string'
    ? input.command
    : typeof input?.description === 'string'
      ? input.description
      : typeof input?.path === 'string'
        ? input.path
        : null

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

  // Read tool result: strip the line-number prefix and render as a
  // code slab with LSP highlighting. CC's Read emits lines like
  // "42\tactual code here" — we strip the prefix and pass the file
  // path so CodeBlock can infer the language and use Monaco/LSP.
  if (sourceTool === 'Read' && !isError) {
    const stripped = stripLineNumberPrefix(trimmed)
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
        <CodeBlock
          code={stripped}
          path={filePath}
          workspaceRoot={codeContext.workspaceRoot}
          codeId={`read:${block.tool_use_id}`}
          engine="monaco"
        />
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
      <MarkerRow marker="⎿" tone="muted">
        <CodeBlock
          code={trimmed}
          path={filePath}
          workspaceRoot={codeContext.workspaceRoot}
          codeId={`grep:${block.tool_use_id}`}
          engine="monaco"
        />
      </MarkerRow>
    )
  }

  return (
    <MarkerRow marker="⎿" tone={isError ? 'muted' : 'muted'}>
      <pre
        className={`
          font-code text-[12px] leading-[1.55] whitespace-pre-wrap break-words m-0
          max-h-[360px] overflow-auto
          ${isError ? 'text-danger' : 'text-ink-dim'}
        `}
      >
        {trimmed}
      </pre>
    </MarkerRow>
  )
})

/**
 * CC's Read tool emits one line per source line, prefixed with the
 * 1-based line number and a tab:
 *
 *   1\timport foo
 *   2\tconst bar = 1
 *
 * Strip the "<digits>\t" prefix from every line so the user sees the
 * raw source. If a line doesn't match the pattern we keep it verbatim
 * — defensive against future format tweaks.
 */
function stripLineNumberPrefix(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/^\s*\d+\t/, ''))
    .join('\n')
}

function stripStreamingMarker(line: string, provider: AgentProvider): string {
  // Provider-specific because the streaming preview is assembled in two
  // stages: parse structure from the plain screen, then pull the same line
  // range out of the markdown reconstruction. If the marker stripper only
  // knows Claude's `⏺`, Codex lines won't line up and the markdown path can
  // re-introduce prompt/status chrome even when the plain parser was right.
  if (provider === 'codex') {
    return line.replace(/^\s*(\*{1,3})?[•◦](\*{1,3})?\s?/, '')
  }
  return line.replace(/^\s*(\*{1,3})?⏺(\*{1,3})?\s?/, '')
}

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

function attachmentLabel(entry: Entry): string {
  const a = (entry as { attachment?: Record<string, unknown> }).attachment ?? {}
  if (a.hookEvent) return `hook: ${(a.hookName as string) ?? (a.hookEvent as string)}`
  if (a.type) return `attachment: ${a.type as string}`
  return 'attachment'
}

/* ---------- Streaming row (transient preview) ---------- */

function StreamingRow({
  screen,
  screenMarkdown,
  baseline,
  activityStatus,
}: {
  screen: string
  screenMarkdown: string
  baseline: string | null
  activityStatus: string | null
}) {
  // ALL structural detection runs on PLAIN text — the parsers look for
  // `⏺`, `⎿`, spinner glyphs etc. which are literal characters in the
  // plain snapshot. In the markdown snapshot, `terminalToMarkdown()`
  // wraps bold cells in `**…**`, so `⏺` becomes `**⏺**` and none of
  // the regexes match. Running the parser on markdown was the bug that
  // caused streaming to show "thinking…" forever even while CC was
  // actively outputting text.
  //
  // Instead we extract from PLAIN, then use the line indices to grab
  // the corresponding lines from the markdown snapshot. The line count
  // is identical between plain and markdown (terminalToMarkdown walks
  // the same rows), so a 1:1 index mapping is correct.
  const currentProvider = useContext(ProviderContext)
  const plainExtract = extractAssistantInProgress(screen, currentProvider)
  const isStale = baseline != null && plainExtract === baseline
  const show = plainExtract && !isStale

  // Map the assistant block to markdown lines. We find where the
  // extracted block sits in the chrome-stripped plain text, then pull
  // the same line range from the markdown version. Both snapshots
  // have the same number of lines (one per terminal row), so we can
  // index directly.
  let display = ''
  if (show) {
    const plainLines = screen.split('\n')
    const mdLines = screenMarkdown.split('\n')
    const extractLines = plainExtract.split('\n')

    // Find the first extracted line in the plain screen. Walk backward
    // since the assistant block is near the bottom.
    const firstExtractLine = extractLines[0]?.replace(/[ \t]+$/, '') ?? ''
    let startIdx = -1
    for (let i = plainLines.length - 1; i >= 0; i--) {
      const plain = plainLines[i]?.replace(/[ \t]+$/, '') ?? ''
      // The extracted text has the `⏺ ` marker stripped, so compare
      // against the plain line with the marker also stripped.
      const stripped = stripStreamingMarker(plain, currentProvider)
      if (stripped === firstExtractLine || plain === firstExtractLine) {
        startIdx = i
        break
      }
    }

    if (startIdx >= 0 && startIdx + extractLines.length <= mdLines.length) {
      // Pull the corresponding markdown lines and strip the marker
      // + continuation indent the same way extractAssistantInProgress
      // does for the plain version.
      const mdBlock = mdLines
        .slice(startIdx, startIdx + extractLines.length)
        .map((l, i) => {
          let cleaned = l.replace(/[ \t]+$/, '')
          if (i === 0) {
            // Strip the marker (possibly wrapped in bold: **⏺** or **⏺ **)
            cleaned = stripStreamingMarker(cleaned, currentProvider)
          } else {
            // Strip 2-char continuation indent (same as the plain parser)
            if (cleaned.startsWith('  ')) cleaned = cleaned.slice(2)
          }
          return cleaned
        })
      display = mdBlock.join('\n').replace(/\n{3,}/g, '\n\n')
    } else {
      // Fallback: use plain text if we couldn't map indices.
      display = plainExtract
    }
  }

  return (
    <MarkerRow marker="⏺">
      {display ? (
        <StreamingProse text={display} />
      ) : (
        <div className="flex items-center gap-2 text-muted text-[12px] py-0.5">
          <span className="streaming-dot inline-block w-1.5 h-1.5 rounded-full bg-accent" />
          <span>{activityStatus ?? 'thinking…'}</span>
        </div>
      )}
    </MarkerRow>
  )
}

/* ---------- Activity indicator (standalone, outside streaming row) ---------- */

// Shown at the bottom of the feed when CC is working but the streaming
// row isn't active (awaitingAssistant is false). Covers tool execution,
// the gap at the very start of a turn, and any state where the spinner
// is visible on CC's screen but we haven't flipped into streaming mode
// yet. Uses the same marker + hanging indent layout as everything else
// in the feed for visual consistency.

function ActivityIndicator({ status }: { status: string }) {
  return (
    <MarkerRow marker="⏺">
      <div className="flex items-center gap-2 text-muted text-[12px] py-0.5">
        <span className="streaming-dot inline-block w-1.5 h-1.5 rounded-full bg-accent" />
        <span>{status}</span>
      </div>
    </MarkerRow>
  )
}
