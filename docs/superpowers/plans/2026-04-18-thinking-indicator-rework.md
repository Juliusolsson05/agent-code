# In-feed working indicator rework

**Scope:** the rendering INSIDE the feed (the scrollable message list) is
the only thing this plan touches. Pane header, tab strip, and the
status-mode whole-bar color flip stay exactly as they are — those are
features, not the problem.

**Companion plan:**
[`2026-04-18-thinking-phase-in-headless.md`](./2026-04-18-thinking-phase-in-headless.md)
covers where `streamPhase` comes from (derived in `ClaudeProxyAdapter` /
`CodexResponsesAdapter`, published as a `SemanticChannel` event). This
plan consumes that field and rebuilds the feed UI around it.

## Problem

Inside the feed, we render a grab bag of sub-block indicators while a
turn is live — but **we never render a single "the agent is working"
row**. The result:

1. **No cohesive "working" affordance.** The bottom-of-feed
   `ActivityIndicator` (`src/renderer/src/feed/Feed.tsx:2544`, plus a
   dead duplicate at `src/shared/ui/ActivityIndicator.tsx`) is the only
   thing that says "something is happening," and it is **suppressed the
   moment a semantic turn mounts**
   (`Feed.tsx:905`: `{semanticTurn == null && activityStatus && (…)}`).
   During the mid-turn gap between a `message_stop` and the next
   `message_start` — which is where a long-running tool execution sits —
   the feed is visually quiet, because there is no block to render a
   row for and the ActivityIndicator is gated off.

2. **`∴ Thinking…` looks frozen, or floods the feed, or both.**
   `SemanticLiveBlockRow`'s thinking branch (`Feed.tsx:1301-1333`)
   streams the full thinking plaintext inline as dim italic. On Opus
   extended-thinking and on ChatGPT encrypted reasoning the plaintext is
   empty — the row renders a static `∴ Thinking…` with no animation and
   no text, indistinguishable from a hang. When plaintext IS available,
   it floods the feed with an italic wall that vanishes the moment the
   block finalizes (thinking is never persisted).

3. **Sub-block chrome competes for "is it working?" attention.** Three
   separate compact rows dress the live turn:
   - `SemanticTaskSummary` (`Feed.tsx:1194`) — a pill with
     `todos: X/Y · active: Bash, Grep · tools: 3 done`.
   - `SemanticCollapsedActivityRow` (`Feed.tsx:1166`) — `working: 2
     searches, 1 read` above a one-line hint.
   - `SemanticTurnFooter` (`Feed.tsx:1604`) — `stop: tool_use · in:
     1234 · out: 567` at the end.
   Each of these is a different glyph (`·` vs `⏺` vs `⎿`), different
   tone, different width. None of them answers the foreground question
   "what is the agent doing right this second?" — they annotate
   surrounding state.

4. **Verb strings leak into the chat.** `ActivityIndicator`'s
   user-visible text is whatever `detectActivity` scraped off the TUI
   spinner — `Cogitating…`, `Newspapering…`, `working… 12s`. It is
   Claude's flavor text, not our vocabulary. It also disappears the
   moment a semantic turn mounts, so the few seconds of visible "verb"
   per turn never form a coherent idiom.

5. **Four markers, no system.** Live thinking uses `⏺ Thinking`.
   Collapsed read-search uses `·` (running) / `⎿` (done). Turn footer
   uses `·`. ActivityIndicator uses `⏺`. The reader cannot predict what
   a marker means without reading the row.

6. **Layout thrash.** The chrome rows mount and unmount as counts cross
   zero, `∴ Thinking` grows from one line to a paragraph as text
   arrives, the ActivityIndicator mounts/unmounts each turn. Each swap
   shifts the feed vertically.

The net: inside the feed, during a long turn, the user cannot tell at a
glance whether the agent is thinking, calling a tool, waiting on a
tool, or hung.

## Out of scope

- **Pane header whole-bar color flip** in status mode
  (`TileLeaf.tsx:896`). Keep. It is how the user reads pane state at
  a glance across a multi-pane grid; that is a feature.
- **Tab bar alive/total badge** (`TabBar.tsx:63`). Keep. Cross-tab
  status is a different problem than the in-feed indicator.
- **`streamPhase` derivation.** Covered end-to-end by the companion
  plan in the headless packages. This plan assumes
  `runtime.streamPhase` already lands.

## Target experience

One `<WorkIndicator/>` row pinned at the foot of the feed, visible
whenever `streamPhase !== 'idle'`. Examples:

```
⏺ user prompt

  ⏺ assistant text …
  ⏺ Grep "streamMode" src/
  ⎿ 4 matches
  ⏺ Read src/providers/claude/runtime/claudeSession.ts

  ─────────────────────────────────────
  ● Calling Read · src/providers/…/claudeSession.ts · 02s
  ─────────────────────────────────────
```

```
⏺ user prompt

  ─────────────────────────────────────
  ● Thinking · 08s
  ─────────────────────────────────────
```

```
⏺ user prompt

  ⏺ assistant text …
  ⏺ Bash `npm run build`

  ─────────────────────────────────────
  ◑ Awaiting Bash · 47s
  ─────────────────────────────────────
```

Properties:

1. **One component, one shape, one animation** — a pulsing dot + phase
   label + elapsed time. No variants, no hidden branches.
2. **One marker.** The dot glyph (the pulsing shape itself) is the
   marker. No more `⏺` / `·` / `⎿` race inside the indicator.
3. **Always present while phase is non-idle.** No `semanticTurn ==
   null` gate. The row is driven directly by `runtime.streamPhase`, so
   it stays visible through tool-execution gaps, initial handshake
   waits, and end-of-stream drain.
4. **Labels from a closed vocabulary.** `Sending`, `Thinking`,
   `Writing`, `Calling <ToolName>`, `Awaiting <ToolName>`, `Compacting`.
   `Cogitating` and `Newspapering` are gone from the user-visible text
   (still available in `DebugPanel` under `activityStatus`).
5. **Elapsed time on every active phase.** Formatted `03s` /
   `2m14s` / `1h04m`. Driven by `runtime.turnStartedAt` + a 1 Hz tick.
6. **`Awaiting` colored amber.** Visual distinction between "agent is
   thinking / writing" (accent) and "tool is running" (amber) —
   amber is what makes "stuck because Bash hasn't returned" legible.
7. **Stable layout.** The row has a fixed height. Phase transitions
   change the label and color, never the row's size. The row fades
   opacity on idle rather than unmounting, avoiding
   mount/unmount-driven scroll jitter.
8. **Collapsed live thinking.** The inline `∴ Thinking…` block becomes
   a compact `<details>` header that opens on click. The indicator
   already says "Thinking · 08s" — the block doesn't need to reiterate
   it with a row full of italic prose.
9. **Sub-block chrome rows removed.** `SemanticTaskSummary`,
   `SemanticCollapsedActivityRow`'s running pill, and
   `SemanticTurnFooter` go away. Todos continue to render via the
   TodoWrite tool's own row (it's already a real tool call that
   reifies as a block). Tool counts are implicit from the tool rows
   themselves; we don't need a separate summary.

## Design

### D1. `<WorkIndicator/>`

New file: `src/renderer/src/feed/WorkIndicator.tsx`.

```ts
type Props = {
  phase: StreamPhase
  turnStartedAt: number | null
  toolName: string | null         // from runtime.streamPhasePendingToolName
  toolHint: string | null         // for 'tool-input'/'awaiting-tool' cases:
                                  //   a single-line trimmed summary of the
                                  //   tool input (e.g. the path for Read,
                                  //   the command for Bash). Derived by
                                  //   the caller — see D3.
  reducedMotion: boolean
}
```

Visual: a single row, full feed width, marker column reserved so the
row aligns with the feed's existing marker grid.

```
  ● Thinking · 08s
```

- **Dot glyph** (`●`, 6 px visual weight): pulses for `thinking`,
  `responding`, `requesting`, `tool-input`, `tool-use`, `submitting`.
  Static-dim for `awaiting-tool` (amber). No glyph for `idle` —
  component renders `null`.
- **Label** (from a `phaseLabel(phase, toolName)` pure fn):
  - `submitting`     → `Sending`
  - `requesting`     → `Connecting`
  - `thinking`       → `Thinking`
  - `responding`     → `Writing`
  - `tool-input`     → `Calling <toolName>`
  - `tool-use`       → `Running <toolName>` (rare; adapter usually moves
                       quickly to `awaiting-tool`)
  - `awaiting-tool`  → `Awaiting <toolName>`
  - `compacting`     → `Compacting`
  - `exited`         → `Ended`
  - `idle`           → `null` (component returns null)
- **Elapsed** (`· 08s`): computed via `useElapsedSeconds(turnStartedAt)`,
  1 Hz tick. Hidden while `turnStartedAt` is null.
- **Hint slot** (`· src/main/index.ts`): only for `tool-input` /
  `tool-use` / `awaiting-tool` when `toolHint` is non-null.
  Truncated to feed-width via CSS `truncate`.

Color:

- `thinking` / `responding` / `requesting` / `submitting` / `tool-input`
  / `tool-use`: `text-accent` for label, `bg-accent` dot.
- `awaiting-tool`: `text-warning` for label, `bg-warning` dot.
  (Warning tokens already exist; `TileLeaf.tsx` uses them for e.g.
  needs-auth states.)
- `compacting`: `text-ink-dim`, neutral dot.
- `exited`: `text-muted`, no dot.

Animation: one CSS keyframe, `cc-work-pulse`, 0.9 s opacity pulse on
the dot. No shimmer, no caret, no verb-gradient. One animation keeps
the "is it working" signal readable across phases. `@media
(prefers-reduced-motion: reduce)` kills the pulse; the dot stays
static-lit.

### D2. Where it renders in the feed

`src/renderer/src/feed/Feed.tsx`.

Remove the current gated ActivityIndicator at `:905`:

```tsx
{semanticTurn == null && activityStatus && (
  <ActivityIndicator status={activityStatus} />
)}
```

Replace with an ungated WorkIndicator rendered AFTER the semantic turn
content (so it sits at the foot of the live turn's blocks):

```tsx
{semanticTurn != null && <SemanticStreamingTurn turn={semanticTurn} />}

{streamPhase !== 'idle' && (
  <WorkIndicator
    phase={streamPhase}
    turnStartedAt={turnStartedAt}
    toolName={streamPhasePendingToolName}
    toolHint={toolHintFromTurn(semanticTurn, streamPhasePendingToolUseId)}
    reducedMotion={reducedMotion}
  />
)}
<div ref={endRef} />
```

The `endRef` sentinel stays the last child — sticky-bottom logic in
`Feed.tsx` already pins to it. The WorkIndicator sits between the last
block and the sentinel, so auto-scroll follows it.

### D3. `toolHintFromTurn` — pure helper

Pulls the most-recent in-progress tool block out of the semantic turn
and returns a ≤1-line hint:

- `Read` / `Edit` / `Write` → `block.parsedInput?.file_path` / `path`
- `Bash` → `block.parsedInput?.command` (first line only)
- `Grep` / `Glob` → `block.parsedInput?.pattern` or `.query`
- `Task` / `AgentTool` → the first 60 chars of the prompt
- Fallback → `null` (indicator shows just "Calling Read")

Lives in `src/renderer/src/feed/workIndicatorHints.ts`. Pure,
memo-able, no dependencies on React. `WorkIndicator` doesn't call it —
`Feed.tsx` calls it and passes the result as a prop, so Feed remains
the one place reading `semanticTurn`.

### D4. What gets deleted

Inside the feed only:

- **`ActivityIndicator` at `Feed.tsx:2544`.** Delete. Sole consumer
  was the `:905` gate, also gone.
- **`src/shared/ui/ActivityIndicator.tsx`** and its export in
  `src/shared/ui/index.ts:4`. Dead code — `rg -n "ActivityIndicator"
  src/` today already shows zero non-Feed consumers.
- **`SemanticTaskSummary` at `Feed.tsx:1194`.** Delete. Todos render
  via the TodoWrite tool's own block (that tool already produces a
  structured content block; `SemanticLiveBlockRow`'s existing
  tool_use branch handles it). "active tools" is redundant with the
  tool rows themselves. "tools: N done" was a count chrome that never
  delivered value.
- **`SemanticCollapsedActivityRow`'s running pill branch at
  `Feed.tsx:1166-1192`.** Keep the component — it's genuinely useful
  for summarising finished read/search groups in history — but remove
  the `working: 2 searches, 1 read` running variant. When a group is
  still accumulating we just show no summary row; the WorkIndicator
  below says what's happening. Concretely, short-circuit the render
  when `unit.isRunning` is true and let the individual tool rows
  below speak for themselves.
- **`SemanticTurnFooter` at `Feed.tsx:1604`.** Delete. `stop: tool_use
  · in: 1234 · out: 567` is diagnostic chatter. DebugPanel already
  surfaces the same info; it doesn't belong in the chat flow.

### D5. Live thinking — compact collapse

**File:** `src/renderer/src/feed/Feed.tsx`, the `thinking` / `reasoning`
branch at `:1301-1333`.

Replace the existing streaming-prose-inline render with a single
`<details>` that defaults closed:

```tsx
if (block.kind === 'thinking' || block.kind === 'reasoning') {
  const text =
    block.thinking || block.reasoningSummary || block.reasoningText || ''
  const hasText = text.length > 0
  if (!hasText) {
    // Nothing useful to render — the WorkIndicator below is the
    // authoritative "thinking" signal. Zero DOM instead of a
    // static-looking placeholder row.
    return null
  }
  return (
    <MarkerRow marker="⏺" tone="muted">
      <details className="text-[12px] text-muted">
        <summary className="cursor-pointer select-none italic">
          ∴ Thinking{block.finalized ? '' : '…'} · click to expand
        </summary>
        <div className="mt-2 not-italic text-ink-dim opacity-90">
          <StreamingProse text={text} />
        </div>
      </details>
    </MarkerRow>
  )
}
```

The empty case — which is where the "looks frozen" bug lives — now
renders zero DOM. The user's "is it thinking?" signal is the
WorkIndicator, which WILL be pulsing.

The completed-block branch at `:2042-2075` gets the same treatment: if
empty, `null`; if non-empty, the same `<details>`.

### D6. Todos and tool summaries

Deleting `SemanticTaskSummary` and the running `SemanticCollapsedActivityRow`
pill looks like we're losing state. We aren't:

- **Todos.** `TodoWrite` is an actual tool the model calls. Its
  `tool_use` block arrives through the same semantic channel and
  renders as a `SemanticLiveBlockRow`. That row already shows the full
  parsed todo list — no separate summary needed.
- **Tool counts.** The tool rows themselves ARE the list. A tool row
  visibly completes (`⏺ → ⎿`) when its `tool_result` lands. Counting
  how many are done is visual clutter.
- **Stop reason / usage.** Stays in DebugPanel. If a user needs it in
  the chat later, a separate per-turn receipt row can be added; don't
  mix it with the work indicator.

## Change plan

Files:

| File | Change |
|---|---|
| `src/renderer/src/feed/WorkIndicator.tsx` | **new** — the component |
| `src/renderer/src/feed/workIndicatorHints.ts` | **new** — `toolHintFromTurn` pure helper |
| `src/renderer/src/feed/Feed.tsx` | replace `:905` gate with WorkIndicator; delete `:2544` ActivityIndicator; gut `:1194` SemanticTaskSummary, `:1166-1192` running pill, `:1604` SemanticTurnFooter; rewrite `:1301-1333` + `:2042-2075` thinking branches |
| `src/renderer/src/styles.css` | add `@keyframes cc-work-pulse`; drop `.streaming-dot` + `@keyframes cc-pulse` (no other consumers after ActivityIndicator dies — confirm with grep) |
| `src/shared/ui/ActivityIndicator.tsx` | **delete** |
| `src/shared/ui/index.ts` | remove `ActivityIndicator` export |
| `src/renderer/src/tiles/TileLeaf.tsx` | thread the three new runtime fields (`streamPhase`, `streamPhasePendingToolName`, `streamPhasePendingToolUseId`, `turnStartedAt`) through to `<Feed>` |

**Untouched (explicit):**

- `src/renderer/src/tiles/TileLeaf.tsx:896-906` — pane header stays
  exactly as is. Whole-bar status-mode flip is a feature.
- `src/renderer/src/tiles/TabBar.tsx:63-108` — alive/total tab badge
  stays exactly as is.
- `src/renderer/src/tiles/workspaceStore.ts` deriveSessionStatus /
  sessionStatus / sessionStatusSource — stays. The in-feed indicator
  is a new, parallel signal driven by streamPhase; it doesn't
  consume or change the existing session-status derivation.

## Order of implementation

Assumes the companion headless plan's steps 1–5 have landed
(`runtime.streamPhase` / `turnStartedAt` / tool fields live in
`SessionRuntime`). If not, gate these behind a feature flag or fall
back to the old pip.

1. **Add `WorkIndicator` + `workIndicatorHints`. Render beside the
   existing ActivityIndicator without removing it yet.** Lets us
   eyeball correctness across all phases (thinking, writing,
   calling, awaiting, compacting) without risking the old fallback
   path. Shippable: yes, dual rendering for one commit.
   *Risk:* low.
2. **Remove the old ActivityIndicator and its gate.** Delete
   `Feed.tsx:905` branch, local component at `:2544`, shared-ui file,
   shared-ui export. Keep only WorkIndicator.
   *Risk:* low — component is narrow; grep confirms no external
   callers.
3. **Rewrite live-thinking block to `<details>`.** Empty → null;
   non-empty → collapsed-by-default details. Same for the persisted
   thinking branch.
   *Risk:* low.
4. **Delete `SemanticTaskSummary`, `SemanticTurnFooter`, and the
   `SemanticCollapsedActivityRow` running variant.** Verify todos
   still render via TodoWrite's tool row. Verify collapsed read/search
   in history still renders the summary (done variant).
   *Risk:* medium — need to confirm we aren't hiding information
   the user actually relies on. DebugPanel already surfaces the
   deleted fields for diagnostic use.
5. **Purge `.streaming-dot` + `cc-pulse` from `styles.css`.** Guard
   with `rg` for residual consumers.
   *Risk:* trivial.

Each step is independently shippable.

## Verification

Manual, in the app:

- Submit a Claude prompt that triggers thinking + tool calls + text.
  Expect the WorkIndicator row at the foot of the feed to transition
  through: `Sending → Connecting → Thinking · Ns → Calling Read ·
  path · Ns → Thinking · Ns → Writing · Ns → (disappears on idle)`.
  The indicator NEVER disappears mid-turn between blocks.
- Submit a Claude Opus prompt with extended thinking. Expect: no
  `∴ Thinking…` row appearing in the feed (encrypted reasoning →
  empty text → null render). The WorkIndicator pulses `Thinking · Ns`
  the entire reasoning span.
- Submit a Codex prompt. Same vocabulary, same transitions.
- Kick off a long-running Bash. Expect `Awaiting Bash · Ns` in amber
  for the duration of the shell's runtime.
- Toggle `prefers-reduced-motion: reduce`. Pulse animation stops;
  the dot stays static-lit. Indicator remains functional.
- Scroll up while a turn is streaming. The WorkIndicator follows the
  feed's sticky-bottom pin; when the user manually unpins, the
  indicator scrolls off with the rest of the feed — that's correct
  (it's content, not chrome).
- Toggle status mode. Pane header whole-bar color flip remains
  untouched. That's the feature preserved.

DebugPanel check:

- `streamPhase`, `streamPhasePendingToolName`, `turnStartedAt` visible
  alongside existing `sessionStatus` / `processActive` rows.
- `activityStatus` continues to show the TUI verb (`Cogitating…`)
  for power users who want the spinner text — it just stops being
  user-visible in the chat.

## Risks

- **`SemanticTaskSummary` is genuinely used.** Possible; I haven't
  heard it called out as load-bearing, but the doc already ships.
  Mitigation: the TodoWrite tool's own row is a full-fidelity
  replacement for the todos view. If users complain, we add a tiny
  header-of-turn summary later — but not as chrome that fights the
  WorkIndicator for attention.
- **`SemanticTurnFooter`'s usage numbers are used for cost triage.**
  Mitigation: DebugPanel has them. If we later want a persisted
  per-turn receipt card, that's a separate feature.
- **Empty-thinking → zero DOM hides the fact that thinking happened.**
  The WorkIndicator showed `Thinking · Ns` for the duration. Persisted
  history therefore records the thinking via the tool-use /
  text blocks around it; we don't need a placeholder row that says
  "thinking happened here" with no content. If users report wanting
  the placeholder back, add it behind `verbose`.
- **Sticky-follow regression.** The row is inside the feed scroller,
  not floated. Auto-scroll still pins `endRef` at the bottom. Confirm
  with a mid-turn scroll test.

## Rollback

Per step:

1. Revert `WorkIndicator.tsx` / `workIndicatorHints.ts` / `Feed.tsx`
   hunk. Restores dual-render (or nothing, if we didn't dual-render).
2. Restore `ActivityIndicator.tsx` (one small file) and the
   `:905` / `:2544` hunks in `Feed.tsx`.
3. Restore the old `∴ Thinking…` branch in `Feed.tsx`.
4. Restore `SemanticTaskSummary` / `SemanticTurnFooter` / the running
   pill variant.
5. Restore `.streaming-dot` CSS.

No persisted state; all changes live in renderer code.

## Out of scope (reconfirmed)

- Pane header chrome — untouched.
- Tab bar badge — untouched.
- Headless phase derivation — separate plan.
- Cross-turn receipt cards (usage / stop reason in the chat) — separate
  feature, deliberately not tangled into the indicator.
- Per-tool "sub-steps tree" inside the live turn — separate feature.
