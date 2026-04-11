import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'

import { diffLines, type DiffLine } from '../../../core/parsers/lineDiff'
import { extractAssistantInProgress } from '../../../core/parsers/claude/streamingScreen'
import {
  isConversationEntry,
  type ContentBlock,
  type ConversationEntry,
  type Entry,
  type ToolResultBlock,
  type ToolUseBlock,
} from '../../../core/types/transcript'

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
// rehype-highlight config:
//   detect: true  — when a fence has no language (```…```), lowlight
//                   auto-detects the language. Without this, unlabeled
//                   fences stay plain text. CC models commonly emit
//                   unlabeled fences for shell output and short snippets,
//                   so this is load-bearing for the common case.
//   languages: undefined — use the `common` set (~40 languages). Covers
//                   every mainstream language; the full set would triple
//                   the bundle for marginal benefit.
//
// Plugin instance is frozen at module scope (with the options baked in)
// because react-markdown v10 caches parse results keyed on plugin
// identity — passing [rehypeHighlight, options] at the call site would
// create a fresh options object every render and bust the cache.
const REHYPE_PLUGINS: import('react-markdown').Options['rehypePlugins'] = [
  [rehypeHighlight, { detect: true }],
]

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

const ToolUseIndexContext = createContext<Map<string, ToolUseBlock>>(new Map())

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

type Props = {
  /** Session identity — used as the key for per-session scroll
   *  position persistence across Feed unmount/remount (tab switches).
   *  See `scrollPositions` below. */
  sessionId: string
  entries: Entry[]
  /** Plain-text screen snapshot. Used for baseline comparison. */
  streamingScreen?: string | null
  /** Same screen with bold/italic cell attributes reconstructed as
   *  markdown. Used for the actual streaming card render. */
  streamingScreenMarkdown?: string | null
  streamingBaseline?: string | null
  showSystemEvents: boolean
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
  entries,
  streamingScreen,
  streamingScreenMarkdown,
  streamingBaseline,
  showSystemEvents,
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
  // skip attachment / permission-mode / file-history-snapshot.
  const visible = showSystemEvents
    ? entries
    : entries.filter(e => isConversationEntry(e))

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
    <ToolUseIndexContext.Provider value={toolUseIndex}>
      <div
        ref={scrollerRef}
        className="h-full overflow-auto"
      >
        <div className="max-w-[880px] mx-auto px-8 pt-6 pb-8 flex flex-col gap-4">
          {visible.map((e, i) => (
            <EntryRow key={(e as Entry).uuid ?? `i${i}`} entry={e} />
          ))}
          {streamingScreen != null && (
            <StreamingRow
              screen={streamingScreen}
              screenMarkdown={streamingScreenMarkdown ?? streamingScreen}
              baseline={streamingBaseline ?? null}
            />
          )}
          <div ref={endRef} />
        </div>
      </div>
    </ToolUseIndexContext.Provider>
  )
}

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
function MarkerRow({
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
      // Dispatch by tool name so Edit / MultiEdit / Write / Read each
      // get their own visually rich renderer. Anything unknown falls
      // through to the generic one-line ToolUseRow so new tools never
      // render as nothing.
      const tu = block as ToolUseBlock
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
      <ReactMarkdown remarkPlugins={COMPLETED_REMARK} rehypePlugins={REHYPE_PLUGINS}>
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
      <ReactMarkdown remarkPlugins={STREAMING_REMARK} rehypePlugins={REHYPE_PLUGINS}>
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

/* ---------- Rich tool renderers: Edit / MultiEdit / Write ---------- */
//
// The generic ToolUseRow above just shows "⏺ Name  ⎿  headline" and
// relies on the following tool_result for any actual content. For file
// edits, that loses all the information — the diff and the new content
// never make it onto the screen. These dedicated renderers render the
// tool_use block's `input` directly instead, producing:
//
//   ⏺ Edit  <filename>
//     <unified line diff with red/green bg per line>
//
//   ⏺ MultiEdit  <filename>  <N changes>
//     <one diff block per edit in the edits[] array>
//
//   ⏺ Write  <filename>
//     <full file content, syntax-highlighted, green-tinted>
//
// The subsequent tool_result for successful Edits ("The file … has been
// updated successfully") is redundant next to the rendered diff, so
// ToolResultRow suppresses it when the originating tool is one of
// these file-write tools and the result isn't an error. Errors still
// fall through as a normal result row so mistakes remain visible.

/** Pull a file path and old/new strings out of a shape we don't fully
 *  trust — the transcript typing is `unknown`. Missing fields become
 *  empty strings so the diff still renders (as "everything added"
 *  or "everything removed") without crashing. */
function editInput(
  block: ToolUseBlock,
): { filePath: string; oldString: string; newString: string } {
  const input = (block.input ?? {}) as Record<string, unknown>
  return {
    filePath: typeof input.file_path === 'string' ? input.file_path : '',
    oldString: typeof input.old_string === 'string' ? input.old_string : '',
    newString: typeof input.new_string === 'string' ? input.new_string : '',
  }
}

/** Short filename extracted from an absolute path. Used in the
 *  compact header so long paths don't blow the column width. The full
 *  path is available as a `title` attribute on hover for disambiguation. */
function basenameOf(path: string): string {
  if (!path) return ''
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Header row for file-tool blocks: "⏺ Edit  <filename>" with the
 *  tool name in accent and the filename in muted ink. Shared between
 *  EditRow / MultiEditRow / WriteRow so they render consistently. */
function FileToolHeader({
  name,
  filePath,
  extra,
}: {
  name: string
  filePath: string
  extra?: string
}) {
  const short = basenameOf(filePath)
  return (
    <div className="text-[13px] leading-[1.65]" title={filePath || undefined}>
      <span className="text-accent font-semibold">{name}</span>
      {short && (
        <span className="text-ink-dim ml-2 font-code text-[12px]">{short}</span>
      )}
      {extra && <span className="text-muted ml-2 text-[11px]">{extra}</span>}
    </div>
  )
}

/**
 * Render a precomputed DiffLine[] as a flat code-slab with per-line
 * red/green tinting. Each line becomes its own <div> so the bg color
 * extends edge-to-edge of the slab rather than hugging the text.
 *
 * Why not one big <pre> with spans: a <pre> uses default block layout
 * on its text nodes, meaning per-line bgs only cover the characters.
 * Flex column of divs gives each line its own box that fills the
 * slab's width — same visual as GitHub's split-line diff rendering.
 *
 * Per-line syntax highlighting is intentionally NOT done in v1. The
 * diff bg colors carry the story ("what changed"), and adding
 * highlight.js per line would either lose cross-line state (wrong
 * colors for multi-line strings) or require running it over the
 * whole block and then splitting the highlighted HTML at newlines
 * while chasing unclosed tags. We can revisit once the structural
 * win lands.
 */
function DiffSlab({ lines }: { lines: DiffLine[] }) {
  if (lines.length === 0) {
    return (
      <div className="bg-code-bg text-muted text-[11px] font-code px-3 py-2">
        (no changes)
      </div>
    )
  }
  return (
    <div className="bg-code-bg font-code text-[12px] leading-[1.55] overflow-x-auto">
      {lines.map((l, i) => {
        // The gutter prefix (`+`/`-`/` `) sits inside the same div as
        // the text so it stays glued to its line when the user scrolls
        // horizontally. A pre-wrap whitespace rule keeps indentation
        // fidelity without forcing horizontal scroll on long lines.
        const bg =
          l.kind === '+'
            ? 'bg-diff-add-bg'
            : l.kind === '-'
              ? 'bg-diff-remove-bg'
              : ''
        // Gutter color carries the +/− signal at full saturation;
        // the body text uses the code-slab ink token (light in
        // every mode because the slab itself is always dark, unlike
        // the mode-sensitive outer ink). Context rows dim the body
        // slightly so changed lines pop against unchanged ones.
        const fg =
          l.kind === '+'
            ? 'text-diff-add-fg'
            : l.kind === '-'
              ? 'text-diff-remove-fg'
              : 'text-code-ink-dim'
        const bodyTone = l.kind === 'ctx' ? 'text-code-ink-dim' : 'text-code-ink'
        return (
          <div
            key={i}
            className={`${bg} flex items-start px-3 whitespace-pre`}
          >
            <span
              className={`${fg} select-none w-4 flex-shrink-0 tabular-nums`}
              aria-hidden="true"
            >
              {l.kind === 'ctx' ? ' ' : l.kind}
            </span>
            <span className={`${bodyTone} flex-1 min-w-0 break-all`}>
              {/* An empty diff line is still a real line; render a
                  zero-width space so the flex box keeps its height
                  and the +/− gutter lines up visually. */}
              {l.text === '' ? '\u200b' : l.text}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// Memoed by block reference — tool_use objects are immutable once
// they land in the JSONL, so identity equality is exact.
const EditRow = memo(function EditRow({ block }: { block: ToolUseBlock }) {
  const { filePath, oldString, newString } = editInput(block)
  // diffLines on two identical empty strings returns []; the slab
  // handles that with a "(no changes)" placeholder. For real edits
  // we feed the raw old/new pair.
  const lines = useMemo(
    () => diffLines(oldString, newString),
    [oldString, newString],
  )
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <FileToolHeader name="Edit" filePath={filePath} />
        <DiffSlab lines={lines} />
      </div>
    </MarkerRow>
  )
})

// MultiEdit: the input carries `edits: [{old_string, new_string}]`.
// We render one diff slab per entry with a thin header separator so
// the reader can see where one change ends and the next begins.
const MultiEditRow = memo(function MultiEditRow({
  block,
}: {
  block: ToolUseBlock
}) {
  const input = (block.input ?? {}) as Record<string, unknown>
  const filePath =
    typeof input.file_path === 'string' ? input.file_path : ''
  const edits = Array.isArray(input.edits)
    ? (input.edits as Array<Record<string, unknown>>)
    : []
  const normalized = edits.map(e => ({
    oldString: typeof e.old_string === 'string' ? e.old_string : '',
    newString: typeof e.new_string === 'string' ? e.new_string : '',
  }))
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <FileToolHeader
          name="MultiEdit"
          filePath={filePath}
          extra={`${normalized.length} change${normalized.length === 1 ? '' : 's'}`}
        />
        <div className="flex flex-col gap-2">
          {normalized.map((e, i) => (
            <MultiEditChunk key={i} index={i} total={normalized.length} edit={e} />
          ))}
        </div>
      </div>
    </MarkerRow>
  )
})

// Split out so the useMemo runs per-chunk, not on the full list.
// Memoization key is (oldString, newString) because edits[] is a
// fresh array literal from JSON parsing and won't hit reference
// stability on its own.
const MultiEditChunk = memo(function MultiEditChunk({
  index,
  total,
  edit,
}: {
  index: number
  total: number
  edit: { oldString: string; newString: string }
}) {
  const lines = useMemo(
    () => diffLines(edit.oldString, edit.newString),
    [edit.oldString, edit.newString],
  )
  return (
    <div>
      {total > 1 && (
        <div className="text-muted text-[10px] uppercase tracking-wider mb-0.5 select-none">
          change {index + 1} / {total}
        </div>
      )}
      <DiffSlab lines={lines} />
    </div>
  )
})

// Write: a brand-new file's full content. Renders as a single
// green-tinted slab (everything is "added"). We deliberately DON'T
// feed the content through diffLines against the empty string — the
// naive approach would produce N `+` lines, which is correct but
// hits the O(m×n) LCS table with m=0 and n=len, wasting time. A
// straight walk over content.split('\n') is instant.
const WriteRow = memo(function WriteRow({ block }: { block: ToolUseBlock }) {
  const input = (block.input ?? {}) as Record<string, unknown>
  const filePath = typeof input.file_path === 'string' ? input.file_path : ''
  const content = typeof input.content === 'string' ? input.content : ''
  const lines = useMemo<DiffLine[]>(
    () =>
      content === ''
        ? []
        : content.split('\n').map(text => ({ kind: '+' as const, text })),
    [content],
  )
  // If Write produced a trailing '\n' the split yields a phantom
  // empty line at the end; drop it so the slab doesn't show an
  // empty green row.
  if (lines.length > 0 && lines[lines.length - 1].text === '') lines.pop()
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <FileToolHeader
          name="Write"
          filePath={filePath}
          extra={`${lines.length} line${lines.length === 1 ? '' : 's'}`}
        />
        <DiffSlab lines={lines} />
      </div>
    </MarkerRow>
  )
})

/* ---------- TodoWrite: rendered checklist ---------- */
//
// CC's TodoWrite tool carries the full todo list on every call — not a
// diff. The `input.todos` array IS the current state after the write,
// so to render the "live task list" UX the user wants, we just show
// every item in the most recent TodoWrite call.
//
// Schema (pinned by claude-code-src/utils/todo/types.ts):
//   { todos: [{ content: string,
//               status: 'pending' | 'in_progress' | 'completed',
//               activeForm: string }, ...] }
//
// `activeForm` is the present-continuous label CC uses for in-progress
// items ("Refactoring parser" vs "Refactor parser"). We surface it only
// when an item is actually in_progress, otherwise `content` reads more
// naturally in a checklist.
//
// We deliberately avoid merging across successive TodoWrite calls in
// one turn: each TodoWrite is its own row. If the user runs a big
// session with 6 TodoWrite updates, they'll see 6 checklists in the
// feed and the rightmost one (furthest down) is the final state. This
// mirrors how CC's own TUI shows the history, and it preserves the
// "append-only feed" mental model the rest of Feed.tsx assumes.

type TodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

/** Type-narrow a TodoWrite tool_use.input without trusting the static
 *  `unknown` typing from the transcript types. Missing fields become
 *  safe defaults so a malformed call renders as an empty checklist
 *  instead of crashing Feed. */
function parseTodos(block: ToolUseBlock): TodoItem[] {
  const input = (block.input ?? {}) as Record<string, unknown>
  const raw = Array.isArray(input.todos) ? input.todos : []
  return raw.map(t => {
    const item = (t ?? {}) as Record<string, unknown>
    const status =
      item.status === 'in_progress' || item.status === 'completed'
        ? item.status
        : 'pending'
    return {
      content: typeof item.content === 'string' ? item.content : '',
      status,
      activeForm: typeof item.activeForm === 'string' ? item.activeForm : '',
    }
  })
}

const TodoRow = memo(function TodoRow({ block }: { block: ToolUseBlock }) {
  const todos = useMemo(() => parseTodos(block), [block])
  const done = todos.filter(t => t.status === 'completed').length
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        {/* Tiny header so the reader knows this is the task list, plus
            a progress count on the right. Muted so it doesn't fight
            the checklist below for attention. */}
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
            {todos.map((t, i) => (
              <TodoItemRow key={i} item={t} />
            ))}
          </ul>
        )}
      </div>
    </MarkerRow>
  )
})

// Per-item row — split out so the memo key is the item object (stable
// inside a memoed parent) and the visual decisions live next to a
// single item at a time.
const TodoItemRow = memo(function TodoItemRow({ item }: { item: TodoItem }) {
  // Glyph + tone selection by status. Unicode box glyphs were chosen
  // over emoji check marks for two reasons: (1) they're single-cell
  // monospace characters, so they align perfectly with the rest of
  // our monospace UI regardless of font fallback; (2) they work in
  // both dark and light modes without needing extra colored SVGs.
  //
  //   pending      → ☐  (empty box)
  //   in_progress  → ◐  (half-filled circle — suggests motion)
  //   completed    → ☑  (checked box)
  const glyph =
    item.status === 'completed'
      ? '☑'
      : item.status === 'in_progress'
        ? '◐'
        : '☐'
  const textCls =
    item.status === 'completed'
      ? 'text-muted line-through'
      : item.status === 'in_progress'
        ? 'text-ink'
        : 'text-ink-dim'
  const glyphCls =
    item.status === 'completed'
      ? 'text-accent'
      : item.status === 'in_progress'
        ? 'text-accent'
        : 'text-muted'
  // When in_progress, prefer activeForm ("Refactoring parser") over
  // content ("Refactor parser") — matches CC's own TUI labeling and
  // is load-bearing for the "what is Claude doing right now?" read.
  const label =
    item.status === 'in_progress' && item.activeForm
      ? item.activeForm
      : item.content
  return (
    <li className="flex items-start gap-2 text-[13px] leading-[1.55]">
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
  // code slab. CC's Read emits lines like "42\tactual code here",
  // which would mix poorly with the rest of the text layout.
  if (sourceTool === 'Read' && !isError) {
    const stripped = stripLineNumberPrefix(trimmed)
    return (
      <MarkerRow marker="⎿" tone="muted">
        {/* text-code-ink, not text-ink: the slab is always dark so
            the prose ink would be invisible in light mode. Same
            reason as DiffSlab. */}
        <pre
          className="bg-code-bg font-code text-[12px] leading-[1.55] whitespace-pre overflow-auto max-h-[360px] m-0 px-3 py-2 text-code-ink"
        >
          {stripped}
        </pre>
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
}: {
  screen: string
  screenMarkdown: string
  baseline: string | null
}) {
  // Staleness detection runs on PLAIN text. The parser walks the
  // chrome-stripped plain screen to find the last `⏺` block (which is
  // what we compare against the baseline). We can't use the markdown
  // version for this — the injected `**`/`*` markers shift the
  // characters around and would flip comparison results on every
  // transition. See streamingBaseline in App.tsx.
  const plainExtract = extractAssistantInProgress(screen)
  const isStale = baseline != null && plainExtract === baseline

  // Render uses the MARKDOWN version. Same extraction logic, same
  // chrome strip — but the resulting text carries bold/italic markers
  // reconstructed from cell attributes, so react-markdown can render
  // them as real formatting. This is the whole point of the dual-
  // snapshot approach in ClaudeSession.
  const mdExtract = extractAssistantInProgress(screenMarkdown)
  const show = plainExtract && !isStale

  const display = show
    ? mdExtract
        .split('\n')
        .map(l => l.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
    : ''

  return (
    <MarkerRow marker="⏺">
      {display ? (
        <StreamingProse text={display} />
      ) : (
        <div className="flex items-center gap-2 text-muted text-[12px] py-0.5">
          <span className="streaming-dot inline-block w-1.5 h-1.5 rounded-full bg-accent" />
          <span>thinking…</span>
        </div>
      )}
    </MarkerRow>
  )
}
