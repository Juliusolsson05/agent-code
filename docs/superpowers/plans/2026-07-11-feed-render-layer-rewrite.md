# Feed RENDER-Layer Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Spec:** `docs/superpowers/specs/2026-07-11-feed-render-layer-rewrite-design.md` — read it first. This plan implements it phase by phase. All file:line references are as of commit `269f9fc`.

**Goal:** Rebuild the feed's RENDER layer (painter + all row components) so streaming code paints highlighted line-by-line with zero remounts, every Claude/Codex tool renders through one purpose-built card that is identical live and committed, and command output is ANSI-aware with exit codes — outshining the native CLIs.

**Architecture:** Providers extract data (`providers/*/renderer/extractors.ts`), a pure resolve layer normalizes committed entry blocks and live semantic blocks into one `ArtifactVM` per artifact (`features/feed/ui/resolve/`), one card per family renders each VM (`features/feed/ui/artifacts/`), and shared streaming-safe primitives sit underneath (`features/feed/ui/kit/`). The ownership ledger, view bridge, and `FeedRenderItem` contract are untouched.

**Tech Stack:** React 18 + memo discipline, highlight.js v11 (static + sealed-line streaming), Monaco only behind desktop expand affordances, Tailwind v4 tokens, zustand app store (existing `customRendering` setting), existing ledger/bridge pipeline.

## Global Constraints

- **DO NOT touch the DECIDE layer:** nothing under `src/renderer/src/rendering/` changes. No new `RenderReason`, no visibility logic in components. If a change seems to need one, STOP and flag it — that is a separate fixture-gated PR.
- **No new test files** (standing repo rule). Verification = `npx tsc -p tsconfig.node.json --noEmit && npx tsc -p tsconfig.web.json --noEmit` (build/vitest do NOT type-check), `NODE_ENV=test npx vitest run` (existing suites incl. bundle/recording corpus must stay green; a corpus divergence must be triaged with a why, never blessed blind), and the per-phase live checklist. Do not add `test:*` scripts.
- **Thick WHY comments** on every new file/decision per `CLAUDE.md` — especially anything ported verbatim (cite the source region) and anything perf-load-bearing.
- **Identity stability (D11):** any new derivation must be reference-stable — same inputs by reference ⇒ same output by reference. Cloning-on-no-op is a bug.
- **Streaming ≈ final:** a tool finishing is a props flip on the same mounted component. Never swap component types or change keys at the streaming→complete boundary.
- **Browser-pure kit:** nothing under `features/feed/ui/kit/` or `ui/artifacts/` may import Node/Electron APIs — the remote phone client mounts the same `<Feed>`. Monaco stays lazy (`import('@renderer/lib/code/monacoRuntime')`) and only behind expand affordances.
- **Debug == paint:** `DebugVisibleRow`/`VisibleDecision` emission (`Feed.tsx:845-900`, `features/feed/types.ts`) must keep working identically.
- **Worktree setup:** work happens on branch `feat/feed-render-rewrite` in `.worktrees/feed-render-rewrite`. Fresh worktrees fail tsc until: `git submodule update --init` and `ln -s ../../node_modules node_modules` (from the worktree root). The `hotkeyBinding.test.ts` failure is pre-existing — ignore it.
- **Commits:** one commit per task minimum, message format `feat(feed): …` / `refactor(feed): …`, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Each phase ends with the live checklist** (§Phase Verification at the bottom) run via `npm run dev` against a real Claude and a real Codex session.

---

# PHASE 1 — Streaming primitives

Phase outcome: live code streams highlighted line-by-line with no Monaco remounts; streaming markdown stops re-parsing the whole message; command output is ANSI-aware. All achieved by surgical swaps inside existing rows — no structural change yet.

### Task 1: ANSI parser + `AnsiText` kit primitive

**Files:**
- Create: `src/renderer/src/features/feed/ui/kit/ansi.ts` (pure parser, no React)
- Create: `src/renderer/src/features/feed/ui/kit/AnsiText.tsx`

**Interfaces:**
- Produces: `parseAnsi(text: string, initial?: AnsiStyle): { spans: AnsiSpan[]; endStyle: AnsiStyle }`, `ANSI_INITIAL_STYLE: AnsiStyle`, `<AnsiText text={string} />`
- Consumed by: Task 5 (`OutputWell`), Task 13 (`CommandCard`)

- [ ] **Step 1: Write the parser** — `ansi.ts`:

```ts
// ANSI SGR subset parser for tool/command output.
//
// WHY this exists: the feed renders command output verbatim into <pre>,
// so colored test runners / build tools show literal `\x1b[0m` garbage
// (the single most-visible rendering gap in Bash-heavy sessions). This
// module turns SGR-styled text into styled span descriptors.
//
// WHY a subset and not a terminal emulator: transcripts carry the raw
// bytes a NON-interactive command wrote to a pipe. We honor SGR color/
// weight codes and normalize carriage-return progress rewrites; cursor
// movement / clear-screen sequences are stripped (they are meaningless
// outside a real terminal grid — the PTY view exists for that).
//
// WHY \r collapses to "keep the last segment": progress bars emit
// `50%\r75%\r100%`; rendering all three lines triples the output and
// reads as garbage. Keeping the final rewrite per line is what the
// user's terminal would have shown at rest.

export type AnsiStyle = {
  fg: number | string | null   // 0-15 palette index, '#rrggbb' for 24-bit/256, or null
  bg: number | string | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
}

export type AnsiSpan = { text: string; style: AnsiStyle }

export const ANSI_INITIAL_STYLE: AnsiStyle = {
  fg: null, bg: null, bold: false, dim: false,
  italic: false, underline: false, inverse: false,
}

// CSI sequences: keep SGR (`m`), strip everything else. Also strip
// OSC (`\x1b]...\x07` / `\x1b]...\x1b\\`) — window titles etc.
const CSI_RE = /\x1b\[([0-9;]*)([a-zA-Z])/g
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

const XTERM_256 = (n: number): string => {
  // 16-231: 6x6x6 cube; 232-255: grayscale ramp. 0-15 return as index.
  if (n < 16) return String(n)
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    const h = v.toString(16).padStart(2, '0')
    return `#${h}${h}${h}`
  }
  const idx = n - 16
  const steps = [0, 95, 135, 175, 215, 255]
  const r = steps[Math.floor(idx / 36)]
  const g = steps[Math.floor((idx % 36) / 6)]
  const b = steps[idx % 6]
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

function applySgr(style: AnsiStyle, params: number[]): AnsiStyle {
  const s = { ...style }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) return { ...ANSI_INITIAL_STYLE }
    else if (p === 1) s.bold = true
    else if (p === 2) s.dim = true
    else if (p === 3) s.italic = true
    else if (p === 4) s.underline = true
    else if (p === 7) s.inverse = true
    else if (p === 22) { s.bold = false; s.dim = false }
    else if (p === 23) s.italic = false
    else if (p === 24) s.underline = false
    else if (p === 27) s.inverse = false
    else if (p >= 30 && p <= 37) s.fg = p - 30
    else if (p === 39) s.fg = null
    else if (p >= 40 && p <= 47) s.bg = p - 40
    else if (p === 49) s.bg = null
    else if (p >= 90 && p <= 97) s.fg = p - 90 + 8
    else if (p >= 100 && p <= 107) s.bg = p - 100 + 8
    else if (p === 38 || p === 48) {
      const target = p === 38 ? 'fg' as const : 'bg' as const
      if (params[i + 1] === 5 && params[i + 2] !== undefined) {
        const c = XTERM_256(params[i + 2]); s[target] = /^\d+$/.test(c) ? Number(c) : c
        i += 2
      } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
        s[target] = `#${[params[i + 2], params[i + 3], params[i + 4]]
          .map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`
        i += 4
      }
    }
  }
  return s
}

/** Collapse carriage-return rewrites per line: keep the final segment. */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .split('\n')
    .map(line => {
      const at = line.lastIndexOf('\r')
      return at === -1 ? line : line.slice(at + 1)
    })
    .join('\n')
}

export function parseAnsi(
  text: string,
  initial: AnsiStyle = ANSI_INITIAL_STYLE,
): { spans: AnsiSpan[]; endStyle: AnsiStyle } {
  const cleaned = collapseCarriageReturns(text).replace(OSC_RE, '')
  const spans: AnsiSpan[] = []
  let style = initial
  let last = 0
  CSI_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CSI_RE.exec(cleaned)) !== null) {
    if (m.index > last) spans.push({ text: cleaned.slice(last, m.index), style })
    if (m[2] === 'm') {
      const params = m[1] === '' ? [0] : m[1].split(';').map(n => Number(n) || 0)
      style = applySgr(style, params)
    }
    // non-SGR CSI: stripped (no span emitted for the sequence itself)
    last = CSI_RE.lastIndex
  }
  if (last < cleaned.length) spans.push({ text: cleaned.slice(last), style })
  return { spans, endStyle: style }
}
```

- [ ] **Step 2: Write the component** — `AnsiText.tsx`. Palette indices 0–15 map through `readXtermTheme()` (`src/renderer/src/workspace/tile-tree/xtermTheme.ts:26` — returns `{ black, red, …, brightWhite }` already luminance-branched for light/dark). Re-read on `THEME_CHANGED_EVENT` (import from `@renderer/app-state/settings/theme`, same event `CodeBlock.tsx:207` uses).

```tsx
import { memo, useEffect, useMemo, useState } from 'react'
import type { ITheme } from '@xterm/xterm'
import { THEME_CHANGED_EVENT } from '@renderer/app-state/settings/theme'
import { readXtermTheme } from '@renderer/workspace/tile-tree/xtermTheme'
import { parseAnsi, type AnsiStyle } from './ansi'

const PALETTE_KEYS = [
  'black','red','green','yellow','blue','magenta','cyan','white',
  'brightBlack','brightRed','brightGreen','brightYellow','brightBlue',
  'brightMagenta','brightCyan','brightWhite',
] as const

function colorOf(v: number | string | null, theme: ITheme): string | undefined {
  if (v === null) return undefined
  if (typeof v === 'string') return v
  return theme[PALETTE_KEYS[v]] as string | undefined
}

function styleOf(s: AnsiStyle, theme: ITheme): React.CSSProperties | undefined {
  const fg = colorOf(s.inverse ? s.bg : s.fg, theme)
  const bg = colorOf(s.inverse ? s.fg : s.bg, theme)
  if (!fg && !bg && !s.bold && !s.dim && !s.italic && !s.underline) return undefined
  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: s.bold ? 600 : undefined,
    opacity: s.dim ? 0.65 : undefined,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: s.underline ? 'underline' : undefined,
  }
}

/** ANSI-aware text renderer for command output. Memoized by text —
 *  committed output never changes; live output grows, and parseAnsi
 *  over a capped OutputWell payload is cheap enough per delta. */
export const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  const [theme, setTheme] = useState<ITheme>(() => readXtermTheme())
  useEffect(() => {
    const onTheme = () => setTheme(readXtermTheme())
    window.addEventListener(THEME_CHANGED_EVENT, onTheme)
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onTheme)
  }, [])
  const { spans } = useMemo(() => parseAnsi(text), [text])
  return (
    <>
      {spans.map((span, i) => {
        const style = styleOf(span.style, theme)
        return style
          ? <span key={i} style={style}>{span.text}</span>
          : <span key={i}>{span.text}</span>
      })}
    </>
  )
})
```

- [ ] **Step 3: Typecheck** — `npx tsc -p tsconfig.web.json --noEmit`. Expected: clean (plus only pre-existing errors, if any — record them first with a pre-change run).
- [ ] **Step 4: Scratch-verify the parser** in the scratchpad (temporary file, not committed): run `npx tsx` over a snippet feeding `parseAnsi('\x1b[31mFAIL\x1b[0m ok\r\x1b[32mdone\x1b[0m')` and assert spans/colors by eye. Delete the scratch file.
- [ ] **Step 5: Commit** — `feat(feed): ANSI SGR parser + AnsiText kit primitive`

### Task 2: `StreamingCodeBlock` — sealed-line highlighted streaming

**Files:**
- Create: `src/renderer/src/features/feed/ui/kit/StreamingCodeBlock.tsx`

**Interfaces:**
- Produces: `<StreamingCodeBlock code={string} language={string | null} path={string | null} blockKey={string} />`
- Consumed by: Task 3 (live fence), Task 18 (`FileWriteCard`), Task 14 (`GenericToolCard` live JSON)

- [ ] **Step 1: Write the component:**

```tsx
import { memo, useMemo, useRef } from 'react'
import hljs from 'highlight.js'
import { normalizeCodeLanguage } from '@shared/code/language'

// Line-by-line streaming code renderer — THE replacement for the
// per-delta Monaco remount that made live code fences jank (the old
// path recreated editor+model+LSP on every token; see the deleted
// engine="monaco" routing at BlockRow.tsx:605-611 @269f9fc).
//
// Contract:
//   - `code` is APPEND-ONLY across renders for a given `blockKey`.
//     Sealed lines (all but the last) are highlighted once and cached
//     by line index; only the partial tail line re-tokenizes per delta.
//   - `blockKey` identifies the stream. If it changes, the cache
//     resets. It must NOT embed the language (the language often
//     arrives a delta after the fence opens — embedding it in the key
//     was remount bug #2 of the old path).
//   - Language changing (late fence info-string, path resolution)
//     invalidates the whole cache ONCE — cheap, happens within the
//     first few deltas — never remounts the component.
//
// WHY stateless per-line highlight (no cross-line state): highlight.js
// v11 removed the v10 `continuation` API. Per-line tokenization is
// wrong only for multi-line constructs (template literals, block
// comments) and self-repairs at finalize when the committed path does
// its one-shot whole-text highlight. That trade buys us: a sealed line
// literally never re-renders.
//
// WHY a cap: per-line spans over a pathological block (thousands of
// lines) still accumulate DOM. Past MAX_HIGHLIGHT_LINES we stop
// highlighting new sealed lines (plain text spans, still append-only).

const MAX_HIGHLIGHT_LINES = 2000

type Sealed = { text: string; html: string | null }

export const StreamingCodeBlock = memo(function StreamingCodeBlock({
  code,
  language,
  path,
  blockKey,
}: {
  code: string
  language?: string | null
  path?: string | null
  blockKey: string
}) {
  const normalized = normalizeCodeLanguage(language ?? null, path ?? null)
  const canHighlight = normalized !== 'plaintext' && !!hljs.getLanguage(normalized)

  // Cache lives in a ref — mutation, not state, because a sealed line
  // must never trigger a render of its own. Keyed by blockKey+language
  // so either changing resets it exactly once.
  const cacheRef = useRef<{ key: string; lines: Sealed[] }>({ key: '', lines: [] })
  const cacheId = `${blockKey} ${canHighlight ? normalized : 'plain'}`
  if (cacheRef.current.key !== cacheId) {
    cacheRef.current = { key: cacheId, lines: [] }
  }

  const lines = useMemo(() => code.split('\n'), [code])
  const sealedCount = lines.length - 1 // last line is the live tail
  const cache = cacheRef.current.lines
  for (let i = cache.length; i < sealedCount; i++) {
    const text = lines[i]
    let html: string | null = null
    if (canHighlight && i < MAX_HIGHLIGHT_LINES && text.length > 0) {
      try {
        html = hljs.highlight(text, { language: normalized, ignoreIllegals: true }).value
      } catch { html = null }
    }
    cache.push({ text, html })
  }
  // Defensive: if code SHRANK (should not happen — append-only contract),
  // drop stale cache instead of painting ghost lines.
  if (cache.length > sealedCount) cache.length = Math.max(0, sealedCount)

  const tail = lines[lines.length - 1] ?? ''
  const tailHtml = useMemo(() => {
    if (!canHighlight || !tail) return null
    try {
      return hljs.highlight(tail, { language: normalized, ignoreIllegals: true }).value
    } catch { return null }
  }, [canHighlight, normalized, tail])

  return (
    <pre className="code-block-static font-code text-[12px] leading-[1.6] whitespace-pre overflow-auto max-h-[360px] m-0 px-3 py-2 text-code-ink">
      <code className={canHighlight ? `hljs language-${normalized}` : undefined}>
        {cache.map((line, i) =>
          line.html !== null ? (
            <span key={i} dangerouslySetInnerHTML={{ __html: `${line.html}\n` }} />
          ) : (
            <span key={i}>{line.text + '\n'}</span>
          ),
        )}
        {tailHtml !== null ? (
          <span dangerouslySetInnerHTML={{ __html: tailHtml }} />
        ) : (
          <span>{tail}</span>
        )}
      </code>
    </pre>
  )
})
```

- [ ] **Step 2: Typecheck** — `npx tsc -p tsconfig.web.json --noEmit`.
- [ ] **Step 3: Commit** — `feat(feed): StreamingCodeBlock sealed-line streaming highlighter`

### Task 3: Kill the live-fence Monaco remount

**Files:**
- Modify: `src/renderer/src/features/feed/ui/semantic/BlockRow.tsx:598-615` (the fence branch)

**Interfaces:**
- Consumes: `StreamingCodeBlock` (Task 2), existing `splitStreamingCodeFence` (`features/feed/lib/helpers.ts:179`)

- [ ] **Step 1: Replace the fence branch.** Current code at `BlockRow.tsx:599-615` renders `<CodeBlock … engine="monaco" codeId={`live:${block.blockIndex}:${fence.language ?? 'plain'}`} …/>`. Replace with:

```tsx
  const text = block.text ?? ''
  const fence = text ? splitStreamingCodeFence(text) : null
  if (fence) {
    return (
      <MarkerRow marker="⏺">
        <div className="flex flex-col gap-2">
          {fence.prose ? <StreamingProse text={fence.prose} /> : null}
          {/* Live open fence — sealed-line streaming highlight. blockKey
              deliberately excludes the language: the info-string often
              arrives a delta after the ``` and a language-bearing key
              remounted the block (the old jank's second half). */}
          <StreamingCodeBlock
            code={fence.code}
            language={fence.language}
            blockKey={`live-fence:${block.blockIndex}`}
          />
        </div>
      </MarkerRow>
    )
  }
```

Update imports: add `StreamingCodeBlock`, and remove the `CodeBlock` import **only if** this was its last use in the file (it is not yet — the Write preview and live-tool-input branches still use it until Tasks 14/18; leave the import).

- [ ] **Step 2: Typecheck + full vitest** — `npx tsc -p tsconfig.web.json --noEmit && NODE_ENV=test npx vitest run`. Corpus suites assert ledger/bridge output, not JSX, so expected green.
- [ ] **Step 3: Live-verify** — `npm run dev`, ask a Claude agent: *"Write me a 120-line TypeScript file, explain as you go"* and watch the fence: code must paint highlighted line-by-line, no flicker, no black-block flash, language arriving late must not restart the block. With proxy streaming OFF (settings), confirm nothing regresses (fence path only runs with semantic deltas).
- [ ] **Step 4: Commit** — `fix(feed): stream live code fences through StreamingCodeBlock, not per-delta Monaco`

### Task 4: `SegmentedMarkdown` — stop re-parsing the whole streaming message

**Files:**
- Create: `src/renderer/src/features/feed/ui/kit/SegmentedMarkdown.tsx`
- Modify: `src/renderer/src/features/feed/ui/semantic/BlockRow.tsx` (final text branch, `:630-634`)
- Modify: `src/renderer/src/features/feed/ui/Feed.tsx:948-954` (`semantic-text` case)

**Interfaces:**
- Produces: `<SegmentedMarkdown text={string} blockKey={string} />` and pure `splitSealedPrefix(text: string): { sealed: string; tail: string }`
- Consumes: `StreamingProse` (`ui/markdown/Prose.tsx:47`), `splitStreamingCodeFence`, `countFenceMarkers` (`lib/helpers.ts:168`), `StreamingCodeBlock` (Task 2)

- [ ] **Step 1: Write the component.** Design: the *sealed prefix* is everything up to and including the END of the last **closed** fence. That string only changes identity when a fence closes (rare), so the memoized `StreamingProse` over it re-parses only then — killing both the O(len²) reparse and the "second fence re-parses the first" defect. The *tail* (small) streams: prose via `StreamingProse`, open fence via `StreamingCodeBlock`.

```tsx
import { memo } from 'react'
import {
  countFenceMarkers,
  splitStreamingCodeFence,
} from '@renderer/features/feed/lib/helpers'
import { StreamingProse } from '@renderer/features/feed/ui/markdown'
import { StreamingCodeBlock } from './StreamingCodeBlock'

// Streaming markdown without whole-message reparse.
//
// The old path fed the ENTIRE growing message through StreamingProse
// every delta; its memo keys on the full string so it never hit during
// streaming — O(len²) unified-pipeline work over a long message, and a
// message streaming its SECOND fence re-parsed the first through
// markdown each delta too (splitStreamingCodeFence only splits the
// last odd fence).
//
// Fix: split at the end of the last CLOSED fence. The sealed prefix
// string changes identity only when a fence closes, so the memoized
// StreamingProse over it is effectively parse-once. Only the tail
// (text since the last closed fence — bounded, usually small)
// re-parses per delta.

export function splitSealedPrefix(text: string): { sealed: string; tail: string } {
  const fences = countFenceMarkers(text)
  if (fences < 2) return { sealed: '', tail: text }
  const closedFences = fences % 2 === 0 ? fences : fences - 1
  // Find the index just past the Nth ``` marker (N = closedFences).
  let idx = -1
  for (let n = 0; n < closedFences; n++) idx = text.indexOf('```', idx + 1)
  // Seal through the end of the closing fence's line.
  const lineEnd = text.indexOf('\n', idx + 3)
  const sealedEnd = lineEnd === -1 ? text.length : lineEnd + 1
  return { sealed: text.slice(0, sealedEnd), tail: text.slice(sealedEnd) }
}

export const SegmentedMarkdown = memo(function SegmentedMarkdown({
  text,
  blockKey,
}: {
  text: string
  blockKey: string
}) {
  if (!text) return null
  const { sealed, tail } = splitSealedPrefix(text)
  const fence = tail ? splitStreamingCodeFence(tail) : null
  return (
    <div className="flex flex-col gap-2">
      {sealed ? <StreamingProse text={sealed} /> : null}
      {fence ? (
        <>
          {fence.prose ? <StreamingProse text={fence.prose} /> : null}
          <StreamingCodeBlock
            code={fence.code}
            language={fence.language}
            blockKey={`${blockKey}:fence`}
          />
        </>
      ) : tail ? (
        <StreamingProse text={tail} />
      ) : null}
    </div>
  )
})
```

- [ ] **Step 2: Route the streaming text paths through it.** In `BlockRow.tsx`, the fence branch from Task 3 and the plain-text fallthrough (`:630-634`) merge into one:

```tsx
  const text = block.text ?? ''
  // …citations branch unchanged, but its StreamingProse also becomes
  // <SegmentedMarkdown text={text} blockKey={`live-text:${block.blockIndex}`} />
  return (
    <MarkerRow marker="⏺">
      <SegmentedMarkdown text={text} blockKey={`live-text:${block.blockIndex}`} />
    </MarkerRow>
  )
```

(The Task-3 fence branch is subsumed: `SegmentedMarkdown` handles open fences itself. Remove the now-dead standalone fence branch.) In `Feed.tsx` case `'semantic-text'` (`:948-954`), replace `<StreamingProse text={item.text} />` with `<SegmentedMarkdown text={item.text} blockKey={`sem-text:${item.turnId}`} />`.

- [ ] **Step 3: Typecheck + vitest + live-verify** — same commands. Live check: a long streaming answer with prose→code→prose→code; typing in the composer during streaming must stay smooth (Performance panel: no >16ms scripting bursts from markdown on every delta).
- [ ] **Step 4: Commit** — `perf(feed): segment streaming markdown — sealed prefix parses once, only the tail re-parses`

### Task 5: `OutputWell`, `StatusBadge`, `ExpandSection` kit chrome

**Files:**
- Create: `src/renderer/src/features/feed/ui/kit/OutputWell.tsx`
- Create: `src/renderer/src/features/feed/ui/kit/StatusBadge.tsx`
- Create: `src/renderer/src/features/feed/ui/kit/ExpandSection.tsx`

**Interfaces:**
- Produces:
  - `<OutputWell text={string} isError={boolean} ansi={boolean} previewLines={number=3} />`
  - `<StatusBadge status={'streaming'|'running'|'complete'|'error'} exitCode={number|null=null} durationMs={number|null=null} />`
  - `<ExpandSection summary={ReactNode} defaultOpen={boolean=false}>{children}</ExpandSection>` — lazy: children mount on first open, stay mounted after (ports the first-open gating pattern from `ToolResultRow.tsx:17-43`).
- Consumed by: Tasks 6, 13, 14, 17–23.

- [ ] **Step 1: Write `OutputWell`** — behavior of `TruncatedOutputRow` (`ui/rows/TruncatedOutputRow.tsx`, quoted in full in the audit: 3-line preview, click-expand, 360px scroll cap, error tint) with two upgrades: `AnsiText` content when `ansi`, and an explicit truncation notice when a byte cap fires. Body content: `ansi ? <AnsiText text={shown} /> : shown`, cap total rendered text at 200_000 chars with a trailing `… output truncated (N more lines)` line (explicit — never silent). Keep `MarkerRow marker="⎿" tone="muted"` as the outer layout. Keep the exact button copy (`… +N lines (click to expand)` / `collapse`) so muscle memory survives.
- [ ] **Step 2: Write `StatusBadge`** — one `<span>` with the small-caps 11px style used today (`text-[11px] uppercase tracking-wider`): `streaming` → `streaming` (muted, subtle pulse via `animate-pulse`), `running` → `running` (muted), `complete` → `✓` + optional `durationMs` formatted `1.2s` (muted), `error` → `exit N` when `exitCode != null` else `failed` (`text-danger`). No layout shift between states (fixed line height).
- [ ] **Step 3: Write `ExpandSection`** — controlled `<details>` wrapper: `onToggle` sets `everOpened`; children render only when `everOpened || defaultOpen` (port the WHY comment from `ToolResultRow.tsx:17-43` about not mounting Monaco eagerly).
- [ ] **Step 4: Typecheck. Commit** — `feat(feed): OutputWell / StatusBadge / ExpandSection kit chrome`

### Task 6: Replace both TruncatedOutputRows with OutputWell (ANSI on)

**Files:**
- Modify: `src/renderer/src/features/feed/ui/rows/ToolResultRow.tsx` (its `TruncatedOutputRow` uses)
- Modify: `src/providers/codex/renderer/rows/CodexRows.tsx:369-410` (delete the private copy) and its call sites (`CodexRows.tsx:505-620` result row)
- Modify: `src/renderer/src/features/feed/ui/semantic/BlockRow.tsx:289-313` and `:572-592` (live output `<pre>`s → `OutputWell`)
- Delete: `src/renderer/src/features/feed/ui/rows/TruncatedOutputRow.tsx` (after all uses migrate; `grep -rn "TruncatedOutputRow" src/` must be empty)

- [ ] **Step 1: Swap call sites.** Each `<TruncatedOutputRow content={X} isError={Y} />` becomes `<OutputWell text={X} isError={Y} ansi />`. The live `<pre>` blocks in `BlockRow.tsx` (function output `:299-312`, tool result `:578-591`) become `<OutputWell text={outputText} isError={block.resultIsError === true} ansi />`.
- [ ] **Step 2: Delete** the Codex private copy (`CodexRows.tsx:369-410`) and the shared file; fix imports.
- [ ] **Step 3: Typecheck + vitest + live-verify** — run a Codex/Claude command with colored output (`npm test` in some repo): colors render, `[0m` garbage gone, expand/collapse works.
- [ ] **Step 4: Commit** — `feat(feed): ANSI-aware OutputWell replaces both TruncatedOutputRow copies`
- [ ] **Step 5: PHASE 1 GATE** — run the full Phase Verification checklist (bottom of this doc). Open a PR for phase 1 (do not merge without the user).

---

# PHASE 2 — Painter shell

Phase outcome: `Feed.tsx` is a thin orchestrator; all scarred behaviors live in named hooks, ported verbatim. Pixel parity — zero visual change.

### Task 7: Extract the behavior hooks

**Files:**
- Create: `src/renderer/src/features/feed/ui/hooks/useStickyBottom.ts`
- Create: `src/renderer/src/features/feed/ui/hooks/useScrollPersistence.ts` (mount restore — the `useLayoutEffect` at `Feed.tsx:393-421`)
- Create: `src/renderer/src/features/feed/ui/hooks/useOlderHistory.ts`
- Create: `src/renderer/src/features/feed/ui/hooks/usePickerAutoScroll.ts` (both picker tweens, `Feed.tsx:591-710`, sharing one `scrollAnimFrameRef`)
- Create: `src/renderer/src/features/feed/ui/hooks/useFeedDebugEmission.ts` (`Feed.tsx:845-900`)
- Modify: `src/renderer/src/features/feed/ui/Feed.tsx`

**Interfaces (exact signatures the new Feed consumes):**

```ts
useScrollFeedBehaviors(args: {
  scrollerRef: RefObject<HTMLDivElement>
  sessionId: string
  tailMode: boolean
  bootstrapping: boolean
  entriesLength: number
  semanticTurnSignal: string
  semanticHistorySignal: string
  hasOlderHistory: boolean
  loadingOlderHistory: boolean
  onLoadOlderHistory?: () => Promise<void>
  onScrollInfo?: (info: ScrollInfo) => void
  scrollToLatestRequest: number
}): void   // composes useScrollPersistence + useStickyBottom + useOlderHistory internally

usePickerAutoScroll(args: {
  scrollerRef: RefObject<HTMLDivElement>
  pickerSelectedUuid: string | null
  codeBlockSelectedId: string | null
}): void

useFeedDebugEmission(args: {
  onDebugLog: Props['onDebugLog']
  entriesLength: number
  visibleEntryCount: number
  renderedRows: DebugVisibleRow[]
  visibleDecisions: VisibleDecision[]
  semanticTurnId: string | null
  renderedSemanticHistoryTurnIds: string[]
  streamPhase: StreamPhase
}): void
```

- [ ] **Step 1: Move, don't rewrite.** Cut each effect + its refs into its hook file **verbatim**, with a header comment: `// PORTED VERBATIM from Feed.tsx:<range> @269f9fc — this logic is scarred; see the WHY comments inline before changing anything.` Preserve every inline comment. The refs that multiple effects share (`stickyBottomRef`, `lastScrollTopRef`, `scrollAnimFrameRef`, `hadSavedPositionOnMountRef`, `loadingOlderRef`, `prevBootstrappingRef`) live inside whichever hook owns their lifecycle; `useScrollFeedBehaviors` owns all the scroll-family refs and composes the three scroll hooks so the sharing stays internal.
- [ ] **Step 2: Rebuild `FeedImpl`** to: context providers (unchanged, `Feed.tsx:980-1030`), tool-index memos (unchanged, `:751-784`), `feedRenderModelFromItems` memo (unchanged, `:800-803`), the two hook calls, and `renderItems.map(renderFeedItem)` (`renderFeedItem` unchanged this phase). Target ≤300 lines.
- [ ] **Step 3: Typecheck + vitest.** Then parity check: `npm run dev`, exercise tab-switch scroll restore, scroll-up-during-stream (must NOT yank down), scroll-back-to-bottom re-follow, older-history load preserving position, copy-assistant/copy-code pickers tween+outline, bootstrap resume landing at bottom. Save a debug bundle before and after (same session) and diff `render-diagnostics.json` row keys — must be identical.
- [ ] **Step 4: Commit** — `refactor(feed): extract scarred Feed behaviors into ui/hooks (verbatim port)`
- [ ] **Step 5: PHASE 2 GATE** — Phase Verification checklist; PR.

---

# PHASE 3 — Artifact layer + CommandCard + GenericToolCard

Phase outcome: the normalization layer exists; commands and generic tools render through ONE card each, identical live and committed; slash commands parse; exit codes visible.

### Task 8: `ArtifactVM` union

**Files:**
- Create: `src/renderer/src/features/feed/ui/artifacts/types.ts`

**Interfaces (produced — later tasks import these exact names):**

```ts
export type ArtifactStatus = 'streaming' | 'running' | 'complete' | 'error'

export type ArtifactBase = {
  id: string
  provider: AgentProviderKind           // from '@shared/types/providerKind'
  status: ArtifactStatus
  plane: 'committed' | 'live'           // debug/provenance ONLY — cards must not branch on it
  toolUseId: string | null
  startedAt: number | null
  endedAt: number | null
}

export type CommandArtifact = ArtifactBase & {
  family: 'command'
  command: string
  cwd: string | null
  description: string | null
  sourceTool: 'Bash' | 'exec_command' | 'local_shell_call' | 'bash'
  output: string | null                 // ANSI-preserved
  exitCode: number | null
  durationMs: number | null
  stdinWrites: string[]                 // write_stdin attachments (Codex)
}

export type GenericToolArtifact = ArtifactBase & {
  family: 'generic'
  toolName: string
  prettyName: string                    // MCP-aware pretty name
  mcp: { server: string; tool: string } | null
  headline: string | null
  params: Record<string, unknown> | null
  paramsJson: string                    // raw (possibly partial) input JSON
  parseError: string | null
  resultText: string | null
  resultIsError: boolean
}

export type SlashCommandArtifact = ArtifactBase & {
  family: 'slash-command'
  name: string
  message: string | null
  args: string | null
  stdout: string | null
}

// Placeholder unions filled by Phases 4–5 (declare now so the resolver's
// return type is stable): FileEditArtifact, FileWriteArtifact,
// ReadArtifact, TodoArtifact, WebArtifact, AgentSpawnArtifact,
// McpArtifact, ImageGenArtifact — each `ArtifactBase & { family: '<x>'; … }`
// with the exact payloads specified in spec §4. Declare ALL of them in
// this task with their full spec §4 fields (they are types only — no
// runtime cost, and later tasks then cannot drift from the contract).

export type ArtifactVM =
  | CommandArtifact | GenericToolArtifact | SlashCommandArtifact
  | FileEditArtifact | FileWriteArtifact | ReadArtifact | TodoArtifact
  | WebArtifact | AgentSpawnArtifact | McpArtifact | ImageGenArtifact
```

- [ ] **Step 1: Write the file** with the full spec-§4 payloads for every family (copy the field lists from the spec verbatim; `DiffLine` imports from `@shared/parsers/lineDiff`).
- [ ] **Step 2: Typecheck. Commit** — `feat(feed): ArtifactVM discriminated union (artifact view-model contract)`

### Task 9: The resolvers — committed + live → VM

**Files:**
- Create: `src/renderer/src/features/feed/ui/resolve/registry.ts` (family routing)
- Create: `src/renderer/src/features/feed/ui/resolve/fromCommitted.ts`
- Create: `src/renderer/src/features/feed/ui/resolve/fromLive.ts`
- Create: `src/providers/claude/renderer/extractors.ts`
- Create: `src/providers/codex/renderer/extractors.ts`

**Interfaces:**
- Produces:
  - `routeFamily(provider: AgentProviderKind, toolName: string): ArtifactVM['family']`
  - `commandFromCommitted(tu: ToolUseBlock, result: ToolResultBlock | null, provider): CommandArtifact`
  - `commandFromLive(block: SemanticLiveBlock, toolState: SemanticToolCallSnapshot | null, provider): CommandArtifact`
  - `genericFromCommitted(...)`, `genericFromLive(...)` — same pattern
  - Claude extractors: `parseSlashCommandEnvelope(text: string): { name: string; message: string | null; args: string | null; stdout: string | null } | null`
  - Codex extractors: `execCommandInput(input: unknown): { command: string; cwd: string | null; yieldTimeMs: number | null; maxOutputTokens: number | null }`, `exitCodeFromResult(result: ToolResultBlock): number | null` (reads `result.codex` meta — shape at `providers/codex/renderer/transcript/rollout.ts:281-297`)
- Consumes: `ToolUseBlock`/`ToolResultBlock` (`@shared/types/transcript`), `SemanticLiveBlock` = `SemanticLiveTurn['blocks'][number]` (`@renderer/session-runtime/state`), `extractToolCommand`/`toolResultText` (`features/feed/lib/helpers.ts:75-96`), headline heuristic merged from `helpers.ts` + `providers/shared/renderer/rows/jsonToolPresentation.ts:33-74` (move `prettifyToolName` from `jsonToolPresentation.ts:9-16` into `registry.ts`).

Key rules (encode as WHY comments):
- **Status derivation, live plane:** `block.finalized !== true && !block.resultAt` while input still streams → `'streaming'`; input finalized, no result (`toolState?.status === 'in_progress'`) → `'running'`; `toolState?.status === 'error' || block.resultIsError` → `'error'`; else with result → `'complete'`.
- **Status derivation, committed plane:** result missing → `'running'` (a committed tool_use whose result hasn't landed yet — the GitCardRow "running…" case, `Block.tsx:149-151`); `is_error` or `exitCode !== 0` → `'error'`; else `'complete'`.
- **Command output, live:** prefer `toolState?.resultContent ?? block.resultContent ?? null`. NOTE: verify during implementation whether `foldEvent.ts` accumulates Codex `tool_output_delta` into the block/lookup (`session-runtime/semantic/foldEvent.ts` — search `tool_output_delta`); if it does not, live output stays null until `tool_completed` and the card simply shows the running state — do NOT add fold logic in this PR (INGEST layer is out of scope; file a follow-up issue instead).
- **Total function:** `routeFamily` returns `'generic'` for anything unrecognized. Never throw; never return "hidden".

- [ ] **Step 1: Write `registry.ts`** — the routing table (`command`: Bash/bash/exec_command/local_shell_call; `slash-command` is routed by the *entry* text envelope, not tool name; everything else `'generic'` until Phases 4–5 extend it) + `prettifyToolName` move + merged `headlineFor(toolName, params)` (order: `command → file_path → path → notebook_path → pattern → query → url → description`, Bash capped via `truncateBashCommand`).
- [ ] **Step 2: Write the four resolver functions** with the status rules above. `commandFromCommitted` pulls: command via `extractToolCommand`, `cwd` from `input.workdir ?? input.cwd ?? null`, description from `input.description`, output via `toolResultText(result)`, exitCode via the Codex extractor (Claude: null).
- [ ] **Step 3: Write the Claude slash extractor.** Envelope grammar (verify against a real transcript row before finalizing the regexes — save one from a live session): `<command-name>/foo</command-name>`, `<command-message>…</command-message>`, `<command-args>…</command-args>` in one user text block; `<local-command-stdout>…</local-command-stdout>` in a follow-up block/entry. Parser: three `RegExp` captures over the text, `null` if `<command-name>` absent.
- [ ] **Step 4: Typecheck. Commit** — `feat(feed): artifact resolvers — committed + live planes normalize to one VM`

### Task 10: `CommandCard`

**Files:**
- Create: `src/renderer/src/features/feed/ui/artifacts/command.tsx`
- Modify: `src/renderer/src/features/feed/ui/rows/Block.tsx` (route committed Bash/exec_command through it)
- Modify: `src/renderer/src/features/feed/ui/semantic/BlockRow.tsx` (route live exec/Bash/local_shell through it)
- Modify: `src/providers/codex/renderer/rows/dispatch.tsx` (drop exec_command/write_stdin routing — CommandCard owns them)

**Interfaces:**
- Produces: `<CommandCard vm={CommandArtifact} />`
- Consumes: `OutputWell`, `StatusBadge`, `MarkerRow`, `AnsiText` (via OutputWell), `truncateBashCommand`

- [ ] **Step 1: Write the card.** Layout (all states, same mounted component):

```tsx
export const CommandCard = memo(function CommandCard({ vm }: { vm: CommandArtifact }) {
  const [showFull, setShowFull] = useState(false)
  const truncated = truncateBashCommand(vm.command)
  const isTruncated = truncated !== vm.command
  return (
    <MarkerRow marker="⏺">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <pre
            className="font-code text-[13px] leading-[1.55] text-ink m-0 whitespace-pre-wrap break-all inline cursor-pointer"
            onClick={() => isTruncated && setShowFull(v => !v)}
            title={isTruncated && !showFull ? 'click to expand full command' : undefined}
          >
            <span className="text-accent select-none">$ </span>
            {showFull ? vm.command : truncated}
          </pre>
          <StatusBadge status={vm.status} exitCode={vm.exitCode} durationMs={vm.durationMs} />
        </div>
        {(vm.cwd || vm.description) && (
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
            {vm.cwd ? <span title={vm.cwd}>cwd: {vm.cwd.split('/').pop()}</span> : null}
            {vm.description ? <span className="italic">{vm.description}</span> : null}
          </div>
        )}
        {vm.stdinWrites.map((chars, i) => (
          <div key={i} className="mt-0.5 text-[11px] text-muted font-code">stdin → {chars.slice(0, 120)}</div>
        ))}
        {vm.output ? (
          <OutputWell text={vm.output} isError={vm.status === 'error'} ansi />
        ) : vm.status === 'complete' ? null /* silent success: header-only row */ : null}
      </div>
    </MarkerRow>
  )
})
```

- [ ] **Step 2: Route committed.** In `Block.tsx` `tool_use` branch, AFTER the git-intent interception (`Block.tsx:138-153` stays first — git cards win) and BEFORE provider dispatch: if `routeFamily(provider, tu.name) === 'command'`, resolve `commandFromCommitted(tu, toolResultIndex.get(tu.id) ?? null, provider)` inside a `useMemo`-equivalent (Block is already memoized per block; resolution is cheap — call directly) and return `<CommandCard vm={vm} />`. In the `tool_result` branch, suppress results whose source tool routed to `'command'` (mirror the git suppression pattern at `Block.tsx:191-200` — same predicate both sides, hoisted, per the #442 lesson). Attach Codex `write_stdin` inputs to the preceding exec's card is **deferred**: for now `write_stdin` routes to `'command'` family as its own compact row (`stdinWrites` populated, `command` = `(stdin)`) — a follow-up may group them; do not build cross-block grouping in the painter (grouping is bridge/ledger territory).
- [ ] **Step 3: Route live.** In `BlockRow.tsx`: the `function_call` branch's `exec_command`/`write_stdin` special cases (`:271-276`) and the `local_shell_call` branch (`:362-382`) become `commandFromLive(block, toolState, provider)` → `<CommandCard vm={vm} />`. Claude live Bash (currently the generic tool_use branch) is picked up when Task 11 replaces that branch — leave until then.
- [ ] **Step 4: Typecheck + vitest + live-verify:** Claude `Bash` (non-git) and Codex `exec_command` runs — committed and live must look identical modulo the status badge; failing command shows red `exit N`; colored output renders ANSI; git commands still show GitCardRow.
- [ ] **Step 5: Commit** — `feat(feed): CommandCard — one command surface, live + committed, ANSI + exit codes`

### Task 11: `GenericToolCard` — the ONE fallback

**Files:**
- Create: `src/renderer/src/features/feed/ui/artifacts/generic.tsx`
- Modify: `Block.tsx` (fallback `JsonToolRow` → `GenericToolCard`), `BlockRow.tsx` (the whole generic live tool branch `:487-596` → `GenericToolCard`; TodoWrite/Write/AskUserQuestion/Edit special cases stay until their phase-4/5 tasks)
- Modify: `src/renderer/src/features/feed/ui/rows/ToolResultRow.tsx` call sites — generic results route through the card's result slot; Read/Grep special branches stay until Task 15

**Interfaces:**
- Produces: `<GenericToolCard vm={GenericToolArtifact} />`
- Consumes: kit primitives; `JsonResultSlab` (`@providers/shared/renderer/rows/JsonResultSlab`) for JSON-shaped results (keep it — it is data-shaped, not plane-shaped); `StreamingCodeBlock` (live partial JSON params, language `json`); `tryExtractJson` (`jsonToolPresentation.ts`)

- [ ] **Step 1: Write the card.** Header: `prettyName` + MCP server pill when `vm.mcp` + `StatusBadge`. Headline line when present. Params: `ExpandSection summary="N params"` → parsed ? pretty JSON via `CodeBlock engine="static" language="json"` (committed/finalized) : `<StreamingCodeBlock code={vm.paramsJson} language="json" blockKey={`params:${vm.id}`} />` (live partial — replaces the raw `<pre>` dump at `BlockRow.tsx:558-563`). `parseError` renders the existing red line (`BlockRow.tsx:565-571`). Result: `tryExtractJson` → `JsonResultSlab`, else `OutputWell ansi`.
- [ ] **Step 2: Wire both planes.** Committed: `Block.tsx:183` fallback becomes `genericFromCommitted(...)` → card. Live: `BlockRow.tsx` tool_use/server_tool_use/mcp_tool_use branch collapses to (in order): AskUserQuestion picker guard (`:409` unchanged) → Edit/MultiEdit reuse (unchanged until Task 16) → TodoWrite (unchanged until Task 18) → Write preview (unchanged until Task 17) → `genericFromLive(...)` → card. Same for the `function_call` non-command fallthrough (`CodexToolRow`/`JsonToolRow live` split at `:282-286` dies).
- [ ] **Step 3: Typecheck + vitest + live-verify:** an MCP tool call (orchestration), a WebSearch, a Read — live card and committed card must be the same card; partial JSON params must render as growing highlighted JSON, not raw text.
- [ ] **Step 4: Commit** — `feat(feed): GenericToolCard — single live+committed fallback, kills the raw-JSON live dump`

### Task 12: Slash-command rendering + Codex silent-success rollout tweak

**Files:**
- Create: `src/renderer/src/features/feed/ui/artifacts/slashCommand.tsx`
- Modify: `src/renderer/src/features/feed/ui/rows/Block.tsx` text case (`:71-83`) — user text blocks matching the envelope route to `SlashCommandRow`
- Modify: `src/providers/codex/renderer/transcript/rollout.ts:281-297` (stop dropping `exit 0` empty-output results — emit a minimal result block instead of `[]`)

- [ ] **Step 1: `SlashCommandRow`.** `parseSlashCommandEnvelope(text)` non-null → render: `UserBand` + `MarkerRow marker="❯"` + `/name` pill (accent, monospace) + message text via `TextProse` + `args` inline + stdout in `<OutputWell ansi>` inside `ExpandSection summary="output"`. Null → existing user-text path unchanged.
- [ ] **Step 2: Rollout tweak.** At `rollout.ts:283` the `if (!output.trim() && exitCode === 0) return []` drop makes silent successes invisible. Change to emit the normal tool_result block with empty content (keeping `codex.exitCode` meta) so the renderer's CommandCard can paint the header-only ✓ row. **This perturbs committed candidates → run the FULL corpus** (`NODE_ENV=test npx vitest run`): new rows should appear as additive divergences; triage each with `why: silent-success now rendered (spec §6 CommandCard)`. If anything NON-additive diverges, revert this step and ship it as its own PR with its own triage.
- [ ] **Step 3: Typecheck + vitest (+ triage) + live-verify:** run `/help` or a custom slash command in Claude — pill + output, no raw XML. Codex `true`-style silent command shows the ✓ header row.
- [ ] **Step 4: Commit** — `feat(feed): slash-command rows + render Codex silent-success commands`
- [ ] **Step 5: PHASE 3 GATE** — Phase Verification checklist; PR.

---

# PHASE 4 — Code artifacts: DiffCard, FileWriteCard, ReadCard, TodoCard

### Task 13: `DiffView` kit primitive + `DiffCard`

**Files:**
- Create: `src/renderer/src/features/feed/ui/kit/DiffView.tsx` (successor to `providers/shared/renderer/rows/DiffSlab.tsx` — port its per-line hljs mechanism, `DiffSlab.tsx:37-48`, add: file header with action badge + move target + `+N −M` counts, per-file collapse for multi-file patches, first/last-K windowing (K=40) with an explicit expander for long diffs)
- Create: `src/renderer/src/features/feed/ui/artifacts/fileEdit.tsx` (`fileEditFromCommitted` / `fileEditFromLive` + `<DiffCard>`)
- Modify: `src/providers/codex/renderer/extractors.ts` — move `parseApplyPatch` (grammar parser, `CodexRows.tsx:67-113`) and `partialApplyPatchInput` + `extractPartialJsonStringMember` (`BlockRow.tsx:106-157`) here
- Modify: `Block.tsx` + `BlockRow.tsx` + both provider `dispatch.tsx` — Edit/MultiEdit/apply_patch route to `DiffCard`; `EditRow`/`MultiEditRow`/`CodexApplyPatchRow` die
- Modify: Codex result path — `patch_apply_end` success renders compact `patch applied ✓ (N files)`; failure renders error + `unified_diff` through `DiffView` line-tinting (replacing the flat `CodeBlock language="diff"` at `CodexRows.tsx:583-589`; parse the unified diff with a tiny `+/-/@@`-prefix line classifier feeding `DiffLine[]` — do NOT import a diff library)

Resolver rules: Claude Edit/MultiEdit → `diffLines(old,new)` from `@shared/parsers/lineDiff` per edit (as `ClaudeRows.tsx:98-99` does); live partial input goes through the ported `claudeLiveEditInput` logic (`BlockRow.tsx:72-93` — move to `providers/claude/renderer/extractors.ts`); while unparseable, `DiffCard` shows the file path (once closed) + raw streaming input via `StreamingCodeBlock` and flips to the diff on parse success (the ONE allowed internal body swap — a partial diff is unparseable by nature; the card and key stay stable).

- [ ] Steps: write DiffView → write resolvers+card → reroute both planes → delete dead rows → typecheck + vitest + live-verify (Claude Edit + MultiEdit + Codex apply_patch, streaming and committed; multi-file patch collapse; failing patch shows tinted diff) → commit `feat(feed): DiffCard + DiffView — unified diff surface for Edit/MultiEdit/apply_patch`.

### Task 14: `FileWriteCard` — highlighted streaming file writes

**Files:**
- Create: `src/renderer/src/features/feed/ui/artifacts/fileWrite.tsx`
- Modify: `BlockRow.tsx` Write preview (`:483-537`) and `ClaudeRows.tsx` `WriteRow` (`:182-206`) → both die, replaced by the card in both planes

Resolver: live via `extractStreamingWriteInput` (`lib/streamingWriteInput.ts:134` — unchanged, it is already the right extractor); committed via parsed `{file_path, content}`. Card: header = path + language pill (`normalizeCodeLanguage(null, path)`) + growing line count + `StatusBadge`; body = `<StreamingCodeBlock code={content} path={filePath} blockKey={`write:${vm.id}`} />` — **this is the B-decision payoff: the live Write preview is now highlighted line-by-line** (the old preview was `highlight={false}`; sealed-line caching makes highlight affordable). Committed renders the same component (already-complete code seals in one pass; identical DOM). Desktop-only "open in Monaco" affordance inside an `ExpandSection` for files > 80 lines (lazy `CodeBlock engine="monaco"`, the `ToolResultRow.tsx:17-43` first-open pattern via `ExpandSection`).

- [ ] Steps: resolver+card → reroute → delete old → typecheck + vitest + live-verify (ask Claude to Write a 200-line file: highlighted line-by-line growth, stable header, line counter ticking; committed view identical) → commit `feat(feed): FileWriteCard — live-highlighted streaming file writes`.

### Task 15: `ReadCard` (Read/Grep/Glob/LS + Codex parsed reads)

**Files:**
- Create: `src/renderer/src/features/feed/ui/artifacts/fileRead.tsx`
- Modify: `ToolResultRow.tsx` — the hardcoded Read (`:114-147`) and Grep (`:152-172`) branches move into the resolver/card; `ToolResultRow` shrinks to the pure generic result renderer used by `GenericToolCard`
- Modify: Codex `exec_command_end` parsed read/search results (`CodexRows.tsx:522-544`, `ExpandableCodeResult`) → route to `ReadCard`

Card: collapsed one-liner (`Read src/foo.ts — 240 lines` / `Grep "pattern" in src/ — 12 matches` / Glob/LS file list count) + `ExpandSection` body: `CodeView`-style static `CodeBlock` (strip `N→` prefixes via `stripLineNumberPrefix`, `helpers.ts:132`), Monaco on expand for large reads (desktop). Glob/LS body: monospace file list with `vscode-icons-js` icons (`getIconForFile` — same dependency the editor explorer uses).

- [ ] Steps → commit `feat(feed): ReadCard — Read/Grep/Glob/LS one-liners with expandable source`.

### Task 16: `TodoCard`

**Files:**
- Create: `src/renderer/src/features/feed/ui/artifacts/todo.tsx`
- Modify: routes: Claude committed `TodoRow` (`ClaudeRows.tsx:241`) + live `SemanticTodoList` (`BlockRow.tsx:510` + `ui/semantic/TodoList.tsx`) → one card fed by `todoFromCommitted` (parsed input `todos[]`) / `todoFromLive` (`parseSemanticTodos(block.parsedInput)`, import from `@renderer/session-runtime/state`)

Card: checklist rows — `pending` dim circle, `in_progress` accent spinner + `activeForm` text, `completed` strikethrough; counts chip in header. Keep OpenCode's reuse working: `registry.ts` routes `todowrite` (lowercase) to `'todo'` too (the OpenCode dispatch at `providers/opencode/renderer/rows/dispatch.tsx` reused Claude's TodoRow — after this task it can simply delete its special case and inherit, DO update it since it's a one-line deletion, not new OpenCode work).

- [ ] Steps → commit `feat(feed): TodoCard — one todo surface, live + committed`.
- [ ] **PHASE 4 GATE** — Phase Verification checklist; PR.

---

# PHASE 5 — Remaining families + legacy deletion + docs

### Task 17: `WebCard` + `ImageGenCard`

**Files:**
- Create: `src/renderer/src/features/feed/ui/artifacts/web.tsx`, `imageGen.tsx`
- Modify: `BlockRow.tsx` `web_search_call` (`:315-337`), `image_generation_call` (`:339-360`), `tool_search_call` (`:384-398`) live chips → cards; Claude WebSearch/WebFetch + Codex rollout-synthesized `web_search`/`image_generation`/`tool_search` committed rows (`rollout.ts:430-513` — do NOT change rollout; resolve from the synthesized tool_use inputs) → same cards

WebCard: kind pill (Search/Open/Find) + query/url (clickable via the existing external-nav-safe link component used by `MarkdownComponents` — reuse, don't hand-roll `<a>`) + `StatusBadge` + result excerpt in `ExpandSection`. ImageGenCard: status + revisedPrompt italic + result (if the result is an image payload, render through the upgraded `ImageBlockRow` from Task 19; else text).

- [ ] Steps → commit `feat(feed): WebCard + ImageGenCard — committed parity for Codex special tools`.

### Task 18: `AgentCard` re-skin + the `Task` spawn-name fix

**Files:**
- Modify: `src/providers/registry.renderer.capabilities.ts:201` — Claude `isSpawnTool`: `name === 'Agent' || name === 'Task' || name.endsWith('__orchestration_create_agent')` (**verify first**: grep a current live Claude transcript for the subagent tool name — `grep -o '"name":"[A-Za-z]*"' ~/.claude/projects/<recent>/[…].jsonl | sort -u`; add what you actually find)
- Modify: `src/renderer/src/features/feed/ui/rows/TaskSubagentRow.tsx` — re-skin on kit chrome (`StatusBadge`; meta as plain inline chips like CommandCard's cwd/description line) — behavior (live status glyph, elapsed, tool counts, `SubagentMiniFeed`, notification join) untouched
- Create: `src/renderer/src/features/feed/ui/artifacts/agentSpawn.tsx` — thin: `agentSpawnFromCommitted` wraps the block + `SubAgentsContext` state; card delegates to the re-skinned `TaskSubagentRow` internals

- [ ] Steps → live-verify a real `Task` spawn shows the card → commit `feat(feed): AgentCard — Task/Agent spawn fix + kit re-skin`.

### Task 19: `McpCard`, thinking/image/system/compaction re-skins, usage hover

**Files:**
- Create: `artifacts/mcp.tsx` (route `mcp__*` from `'generic'` to `'mcp'` in `registry.ts`; card = GenericToolCard + server pill + params/result emphasis)
- Create: `artifacts/thinking.tsx` — ONE renderer replacing the live (`BlockRow.tsx:206-245`) and committed (`Block.tsx:84-115`) duplicates; adds Codex summary/full tracks (in-place toggle) and an explicit `redacted by provider` pill for `redacted_thinking` (currently silently dropped)
- Modify: `ui/rows/ImageBlockRow.tsx` — support `source.type === 'url'` (plain `<img src>`; `imageDataUrl` at `helpers.ts:210` stays for base64) + click-to-zoom overlay (simple fixed-position lightbox, ESC/click closes, no dependency)
- Modify: `ui/rows/SystemRow.tsx` — hooks get name + collapsible payload via `ExpandSection` (still hidden by default per Feed rule 3)
- Modify: `ui/rows/CompactBoundaryRow.tsx` / `CompactSummaryRow.tsx` — kit chrome pass only
- Modify: `ui/rows/ConversationRow.tsx` — assistant marker gains an optional hover affordance showing `message.usage` token counts when the existing dev-debug setting is on (`features/debug/devDebugConfig.ts` store — add nothing new; gate on an existing flag)
- Modify: `features/feed/workIndicatorHints.ts` — enrich the WorkIndicator tool-hint vocabulary with per-family verbs from `resolve/registry.ts` ("Running `npm test`", "Editing `foo.ts`", "Searching the web") — display-string change only, `streamPhase` machine untouched (spec §7)

- [ ] Steps → commit `feat(feed): McpCard + thinking/image/system/compaction polish + usage hover`.

### Task 20: Legacy deletion + capability-table cutover

**Files:**
- Modify: `src/providers/registry.renderer.capabilities.ts` — delete `renderToolUse`/`renderToolResult` from the capability type and all three providers (routing now lives in `resolve/registry.ts`; provider knowledge lives in `extractors.ts`)
- Delete: `providers/shared/renderer/rows/JsonToolRow.tsx`, `features/feed/ui/rows/ToolUseRow.tsx`, `providers/shared/renderer/rows/DiffSlab.tsx`, the JSX remains of `providers/claude/renderer/rows/ClaudeRows.tsx` + `providers/codex/renderer/rows/CodexRows.tsx` (+ their `dispatch.tsx` files), `ui/semantic/TodoList.tsx`
- Modify: `Block.tsx` → shrinks to: text/thinking/image dispatch + git interception + spawn/AskUserQuestion routing + `routeFamily` → card. `BlockRow.tsx` → shrinks to: thinking + AskUserQuestion picker + `routeFamily` → card + `SegmentedMarkdown` text tail.
- Verify: `grep -rn "JsonToolRow\|ToolUseRow\|DiffSlab\|CodexToolRow\|TruncatedOutputRow\|EditRow\|MultiEditRow\|WriteRow\|renderToolUse\|renderToolResult" src/ packages/ --include='*.ts*'` → only hits in this plan/spec docs. OpenCode's dispatch must still compile — its `renderToolUse` usages are deleted with the capability; its tools route through `routeFamily` defaults (`'generic'`/`'todo'`/`'command'` for `bash`) — **behavioral upgrade for free, verify nothing worse**.

- [ ] Steps → full typecheck both projects + full vitest + `npm run fixture:audit` → commit `refactor(feed): delete legacy dual-ladder tool rendering — resolve/artifacts owns the paint`.

### Task 21: Documentation

**Files:**
- Modify: `docs/rendering/rendering-system.md` §5 (Stage RENDER) — rewrite to describe: view bridge unchanged → `renderFeedItem` → `resolveArtifact` → artifact cards → kit; the VM contract; the streaming primitives; update §7 "Where to look" table rows for the painter/row-dispatch/live-rows entries; delete stale references to removed components (per the doc's own rule: fix stale docs you touch, same PR)
- Modify: `docs/rendering/rendering-design-principles.md` — one paragraph in §5 noting the painter's artifact layer must stay decision-free (pointer to spec)

- [ ] Steps → commit `docs(rendering): update rendering-system.md for the artifact painter`.
- [ ] **PHASE 5 GATE** — full Phase Verification below; final PR.

---

# Phase Verification checklist (run at every phase gate)

1. `npx tsc -p tsconfig.node.json --noEmit && npx tsc -p tsconfig.web.json --noEmit` — clean (modulo recorded pre-existing errors).
2. `NODE_ENV=test npx vitest run` — green; any corpus divergence triaged with a written `why`, never blessed blind.
3. `npm run fixture:audit` — no regressions.
4. `npm run dev`, one Claude + one Codex session, exercise and eyeball:
   - long streaming answer with 2+ code fences (line-by-line highlight, no flicker/remount, late language OK)
   - Edit + MultiEdit + apply_patch (streaming and committed)
   - Write of a 200+ line file (highlighted growth, line counter)
   - colored `npm test`-style command (ANSI + exit badge), a failing command (red `exit N`), a silent success (✓ header row)
   - WebSearch/WebFetch, an MCP call, a subagent `Task` spawn, a slash command
   - provider switch mid-session (committed path renders translated transcript)
   - scroll: up-during-stream stays put; back-to-bottom re-follows; tab-switch restores; older-history preserves position
   - phone client (`client:dev` remote): feed paints, no Monaco in bundle (`ls`+size-check the client build output before/after phase 1)
5. Performance panel: streaming a long code block produces no per-delta long tasks; before/after comparison on the same recorded scenario.
6. Save a debug bundle mid-stream; `render-diagnostics.json` and feed-debug rows still populate (debug == paint intact).

# Task-order dependency notes

- Tasks 1→2→3→4 are strictly ordered; 5–6 can follow in any order after 1.
- Phase 2 (Task 7) can technically run before Phase 1 but do NOT — the primitive swaps land visible user value first and shrink the file Task 7 ports.
- Task 8 blocks 9; 9 blocks 10–12; Phase 4 tasks are independent of each other after 9; Phase 5 Tasks 17–19 independent after 9; Task 20 strictly last-but-one; 21 last.

# Self-review notes (already applied)

- Spec §5.1's hljs `continuation` claim was corrected in the spec (v11 removed the API) — `StreamingCodeBlock` is stateless-per-line with finalize repair, documented in its header.
- `write_stdin` grouping under the parent exec card was demoted to a follow-up (cross-block grouping in the painter would be a decision — ledger territory).
- Live Codex `tool_output_delta` accumulation is verify-first (Task 9): if INGEST doesn't fold it, the card shows `running` until completion and a follow-up issue is filed — no INGEST changes in this plan.
