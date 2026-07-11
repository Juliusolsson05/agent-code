# Feed RENDER-Layer Rewrite — Design Spec

> **Date:** 2026-07-11
> **Status:** approved design (user-approved in session; implementation plan follows in `docs/superpowers/plans/`)
> **Scope decisions (user-locked):** hybrid visual direction (transcript skeleton + rich artifact cards) · live line-by-line highlighted code streaming (sealed-line cache, no live diff theatrics) · Claude + Codex only (OpenCode inherits shared primitives, gets no dedicated work)
> **Companion reading:** `docs/rendering/rendering-system.md` (the pipeline this painter sits on), `docs/rendering/rendering-design-principles.md` (the discipline; the ledger is NOT touched by this work)

---

## 1. Why this rewrite exists

The 2026-07 ownership-ledger rewrite fixed the *decision* layer — what is visible, who owns it, in what order. It deliberately carried the *paint* layer forward mostly unchanged, and the paint layer is now the weakest part of the app. The goal of this rewrite is blunt: **outshine the native Claude Code and Codex CLIs at rendering commands, code-edit streaming, file-write streaming, and the formatting of every artifact type.** We are a browser engine competing with TUIs; there is no excuse to be worse.

### 1.1 The audit findings this design answers

A four-way deep audit (components, git history, tool coverage, data shapes) established the following. Each finding is a design input; file:line references are as of `269f9fc`.

**Streaming code (the headline regression):**

- The live open code fence renders through Monaco, and `CodeBlock`'s Monaco effect lists `code` in its dependency array — **every streaming delta disposes and recreates the entire Monaco editor, model, and LSP document** (`src/renderer/src/lib/code/CodeBlock.tsx:104-260`, effect deps at `:260`; fence routing at `features/feed/ui/semantic/BlockRow.tsx:605-611`). There was never an incremental path; git history confirms Monaco was never incremental (original `13dfc22` already had `code` in deps).
- The fence `CodeBlock` key embeds `fence.language` (`BlockRow.tsx:608`); models emit ``` then the language a delta later, so the key flips `plain → tsx` and React remounts the block a second time.
- `StreamingProse` memoizes on the full growing string (`features/feed/ui/markdown/Prose.tsx:47-63`) — every delta re-parses the entire message's markdown AST (remark-gfm + remark-breaks): O(len²) over a message. `splitStreamingCodeFence` (`features/feed/lib/helpers.ts:179-197`) only splits the *last* odd fence, so a message streaming its second code block re-parses the first through markdown every delta too.
- The "line-by-line like before" memory refers to the pre-semantic **screen-buffer era** (append-only plain text via `StreamingProse`) — removed by the 2026-04 semantic migration. The regression is the switch from append-only DOM to per-delta Monaco remount, not a lost incremental highlighter.
- The one well-done streaming path is the **Write preview** (`BlockRow.tsx:483-537` + `features/feed/lib/streamingWriteInput.ts`): single-pass extractor, static append-only block, stable `write-live:${blockIndex}` key — but unhighlighted (`highlight={false}`).

**Command/tool rendering coverage:**

- **No ANSI handling anywhere in the feed** — command output goes verbatim into `<pre>`; colored test/build output renders as literal `[0m` garbage (`features/feed/ui/rows/TruncatedOutputRow.tsx:32-39` and the near-identical private copy at `providers/codex/renderer/rows/CodexRows.tsx:369-410`).
- **Exit codes are parsed but never displayed.** Codex stores `exit_code` in tool_result meta (`providers/codex/renderer/transcript/rollout.ts:281-297`) and uses it only to tint the pre red. Silent successes (`!output.trim() && exitCode === 0`) are dropped entirely (`rollout.ts:283`).
- Claude's dispatch special-cases exactly four tools — Edit, MultiEdit, Write, TodoWrite (`providers/claude/renderer/rows/dispatch.tsx:11-28`). **Read, Grep, Glob, LS, Bash, WebSearch, WebFetch, NotebookEdit, and all MCP tools fall to the generic `JsonToolRow`** (name + headline + collapsed params `<details>`).
- **Live and committed views of the same tool diverge**: the live generic tool card is hand-rolled (`BlockRow.tsx:487-596`), doesn't reuse `JsonToolRow`, and dumps raw partial `block.inputJson` in a `<pre>` (`:558-563`). Codex `web_search_call` / `image_generation_call` / `local_shell_call` / `tool_search_call` have bespoke live chips (`BlockRow.tsx:315-398`) but their rollout-synthesized committed twins fall to `JsonToolRow` (`rollout.ts:430-513`; the code admits the drift at `:417-428`).
- **Slash commands render as raw XML** — nothing parses Claude's `<command-name>` / `<command-message>` / `<local-command-stdout>` envelope; invocations paint as literal tags in user bubbles.
- Claude subagent cards key on tool name `'Agent'` (`registry.renderer.capabilities.ts:201`), but modern Claude Code emits **`Task`** — the polished `TaskSubagentRow` likely never fires for current transcripts. (Verify against a live transcript during implementation; treat `Task` and `Agent` as synonyms.)
- Two generic tool-use renderers coexist (`ToolUseRow.tsx`, `JsonToolRow.tsx`) with overlapping headline logic (`helpers.ts:44-56` vs `jsonToolPresentation.ts:33-74`); `TruncatedOutputRow` is duplicated (shared + Codex private copy). Codex successful `patch_apply_end` renders nothing (`CodexRows.tsx:561`), so a grammar-parse failure on the tool_use side leaves a successful patch with no visual confirmation at all. Claude Read/Grep specialness is hardcoded by tool name inside the shared `ToolResultRow` (`ToolResultRow.tsx:114,152`) instead of provider-owned.
- Dropped shapes that reach the UI: url-sourced images (only base64 renders), `citations` content (only a count badge), `redacted_thinking`/`connector_text`/`document`/`container_upload`/`web_search_tool_result`/`code_execution_tool_result` block kinds (fall through to an empty text branch), `Message.usage`/`model` (never rendered), hooks/system payloads (one-line muted label).

**Structure:**

- Two parallel dispatch ladders — committed `features/feed/ui/rows/Block.tsx:119-212` and live `features/feed/ui/semantic/BlockRow.tsx` (a 635-line if-ladder) — that already drifted apart once and will again. Provider row modules mix extraction and JSX. The feed is not virtualized by explicit, documented decision (`LazyEntry.tsx:20-37`); this rewrite does not relitigate that.

### 1.2 What this rewrite is NOT

- **Not a DECIDE-layer change.** The ownership ledger, view bridge, `FeedRenderItem` union, ordering law, ghost predicate, and every `RenderReason` are untouched. No new suppression, no new visibility logic. If during implementation something seems to need a visibility decision, it goes to the ledger as a separate, fixture-gated change — not into the painter.
- **Not a virtualization project.** `LazyEntry` + `EAGER_TAIL` policy is ported as-is.
- **Not an OpenCode feature round.** OpenCode keeps its fallbacks; it benefits only through the shared kit.

---

## 2. Hard contracts the new painter must honor

1. **Input contract:** the painter consumes `FeedRenderItem[]` from `useLedgerFeedItems` (`features/feed/ledger/useLedgerFeedItems.ts`) and paints every item it is handed. A ledger-selected candidate that cannot be resolved must land in `dropped[]` (bridge behavior, unchanged) — never silently unpainted.
2. **Debug == paint:** the painter keeps emitting `DebugVisibleRow` / `VisibleDecision` (`features/feed/types.ts`) derived from what it actually painted. `saveDebugBundle` and feed-debug logging must keep working unmodified or with mechanical adaptation only.
3. **Identity stability (D11):** all memoization keyed on object identity must survive. A row whose VM inputs did not change must not re-render. The artifact-resolution layer introduced by this design must be reference-stable: same `FeedRenderItem` + same tool-index version ⇒ same VM object by reference.
4. **One Feed, two hosts:** desktop `TileLeaf` and the phone `remote-client/src/ui/SessionView.tsx` mount the same `<Feed>` with `renderItemsOverride`. The kit must therefore stay browser-pure (no Node imports, no Electron), and Monaco must remain a lazy, desktop-expand-only concern so the phone bundle stays lean.
5. **No new test files** (standing repo rule): verification rides on the existing corpus/replay suites (which assert ledger + bridge output and are structurally unaffected), `tsc` on both projects, the rendering-fixture audit script, and live eyeballing. Temporary fixtures during development are fine; they don't get committed.
6. **Streaming ≈ final:** a tool/block finishing must be a **props flip on the same mounted component** (status `streaming` → `complete`), never a component swap or remount. This is the convergence rule the old code aimed at and only partially achieved; in the new design it holds by construction.

---

## 3. The architecture

### 3.1 One sentence

**Providers extract data, `resolve/` normalizes both planes (committed entry blocks and live semantic blocks) into one `ArtifactVM` per logical artifact, `artifacts/` renders each VM family with exactly one card, and `kit/` supplies the streaming-safe primitives underneath.**

### 3.2 Directory structure

```
features/feed/
  ui/
    Feed.tsx                    # thin list orchestrator: map(item → row), target ~150 lines
    hooks/                      # Feed.tsx's scarred behaviors, PORTED (logic verbatim), not re-derived
      useStickyBottom.ts        #   sticky-bottom follow + scroll listener ownership
      useScrollPersistence.ts   #   scroll position across unmount/remount
      useLazyWindow.ts          #   LazyEntry + EAGER_TAIL keyed on committed ordinal
      useOlderHistory.ts        #   older-history load trigger
      useFeedDebugEmission.ts   #   DebugVisibleRow / VisibleDecision emission
      usePickerAutoScroll.ts    #   picker auto-scroll tweens
    kit/                        # visual primitives — provider-blind, decision-free, browser-pure
      MarkerRow.tsx             #   ❯ ⏺ ⎿ transcript skeleton (kept, polished)
      ArtifactCard.tsx          #   card chrome: header row, status strip, expand, meta chips
      StatusBadge.tsx           #   streaming | running | done | error | exit-N badge
      MetaChips.tsx             #   cwd / duration / description / counts chips
      AnsiText.tsx              #   SGR subset parser → styled spans (colors, bold, dim, reset)
      StreamingCodeBlock.tsx    #   sealed-line hljs cache + one live tail line (§5.1)
      SegmentedMarkdown.tsx     #   fence-segmented streaming markdown (§5.2)
      OutputWell.tsx            #   collapsible capped output region (kills both TruncatedOutputRows)
      DiffView.tsx              #   DiffSlab successor: file header, ± stats, per-line syntax tint
      CodeView.tsx              #   static hljs view; "open in Monaco" only on expand (desktop)
      ExpandSection.tsx         #   lazy <details> successor (first-open mount, preserved-open state)
    artifacts/                  # one file per family = VM type + derivation + card
      types.ts                  #   ArtifactVM discriminated union + shared status model
      command.tsx               #   CommandArtifact  + <CommandCard>
      fileEdit.tsx              #   FileEditArtifact + <DiffCard>      (Edit / MultiEdit / apply_patch)
      fileWrite.tsx             #   FileWriteArtifact + <FileWriteCard>
      fileRead.tsx              #   ReadArtifact     + <ReadCard>      (Read / Grep / Glob / LS)
      web.tsx                   #   WebArtifact      + <WebCard>       (WebSearch / WebFetch / web_search_call)
      agentSpawn.tsx            #   AgentSpawnArtifact + <AgentCard>   (Task / Agent / spawn_agent / orchestration_create_agent)
      todo.tsx                  #   TodoArtifact     + <TodoCard>
      mcp.tsx                   #   McpArtifact      + <McpCard>
      slashCommand.tsx          #   SlashCommandArtifact + <SlashCommandRow>
      imageGen.tsx              #   ImageGenArtifact + <ImageGenCard>  (Codex image_generation_call)
      localShell.tsx            #   folded into CommandArtifact derivation (kept here only if shapes diverge)
      generic.tsx               #   GenericToolArtifact + <GenericToolCard> — THE one fallback
      prose.tsx                 #   assistant/user text (SegmentedMarkdown host)
      thinking.tsx              #   one thinking renderer for live + committed (kills the duplicate)
      image.tsx                 #   base64 AND url image sources
      system.tsx                #   hooks / permission-mode / snapshots (improved SystemRow)
      compaction.tsx            #   CompactBoundaryRow / CompactSummaryRow re-skinned on kit
    resolve/
      resolveArtifact.ts        #   FeedRenderItem → ArtifactVM (pure, memo-cached, reference-stable)
      pairing.ts                #   committed tool_use + tool_result pairing via existing tool indices
      registry.ts               #   family routing table: (provider, toolName) → family + extractor

providers/claude/renderer/
  extractors.ts                 # pure data extraction only, NO JSX: Edit/Write/Read/etc. input shapes,
                                #   slash-command envelope parser, git intent (existing detectGitIntent moves here)
providers/codex/renderer/
  extractors.ts                 # exec_command args, apply_patch grammar (parseApplyPatch moves here),
                                #   exit codes, web_search/image_gen/local_shell metadata, write_stdin
```

Deleted at the end of the migration (each family cut-over deletes its slice): `features/feed/ui/rows/Block.tsx`'s dispatch ladder, `ui/semantic/BlockRow.tsx`'s if-ladder, `ToolUseRow.tsx`, `JsonToolRow.tsx` (+ `jsonToolPresentation.ts` merged into extractors/generic), both `TruncatedOutputRow`s, `DiffSlab.tsx` (superseded by `DiffView`), the JSX halves of `ClaudeRows.tsx` / `CodexRows.tsx`, `StreamingProse`'s whole-string path, and the live-fence Monaco routing in the old `BlockRow`.

### 3.3 The capability-table seam moves up a level

Today `registry.renderer.capabilities.ts` exposes `renderToolUse` / `renderToolResult` (JSX-returning). In the new design providers expose **extractors** (shape → typed data) and the artifact registry owns family routing. The capabilities table keeps everything else (mappers, fold policies, identity, `isSpawnTool` — with the `Task` fix). This keeps "adding a provider = one mapper + one fold policy + one condition policy + one extractor module," and it means a provider can never again fork the *visual* language — only feed it.

---

## 4. The `ArtifactVM` union (the load-bearing type)

All VMs share:

```ts
type ArtifactStatus = 'streaming' | 'running' | 'complete' | 'error'
// streaming = tool input still arriving (tool_input_delta / partial inputJson)
// running   = input finalized, awaiting result (in_progress in SemanticLookupSnapshot)
// complete  = result attached (or committed pair resolved) without error
// error     = is_error result / exitCode != 0 / parse-refusal

interface ArtifactBase {
  id: string                 // ledger candidate id when present; else `entry:<uuid>:<blockIdx>` — NEVER visible index
  family: ArtifactFamily
  provider: AgentProviderKind
  status: ArtifactStatus
  plane: 'committed' | 'live'    // provenance for debug emission only — cards MUST NOT branch on it
  toolUseId?: string
  startedAt?: number | null
  endedAt?: number | null
}
```

Family payloads (fields sourced from the shape inventory — `SemanticLiveBlock` in `session-runtime/state.ts`, `ToolUseBlock`/`ToolResultBlock` in `shared/types/transcript.ts`, Codex rollout payloads in `providers/codex/renderer/transcript/rollout.ts`):

- **`CommandArtifact`** — `{ command: string; cwd?: string; description?: string; source: 'Bash' | 'exec_command' | 'local_shell_call' | 'bash'; output: { text: string; ansi: boolean } | null; exitCode?: number | null; durationMs?: number | null; yieldTimeMs?: number; maxOutputTokens?: number; stdinWrites?: string[] }`. Live: command from partial JSON via closed-key extraction; output grows from `tool_output_delta` (Codex) or attaches at `tool_result` (Claude). Committed: paired result content + `codex.exitCode` meta.
- **`FileEditArtifact`** — `{ filePath: string | null; edits: Array<{ old: string; new: string }>; patchFiles?: Array<{ path: string; action: 'add'|'update'|'delete'; movedTo?: string; lines: DiffLine[] }>; diff: DiffLine[] | null }`. Sources: Claude `Edit` `{file_path, old_string, new_string}` / `MultiEdit` `{file_path, edits[]}` via `diffLines`; Codex `apply_patch` via the `*** Begin Patch` grammar parser. Live: filePath appears as soon as its JSON key closes; diff body renders when parseable, else the card shows the streaming raw input in a `StreamingCodeBlock` until it is.
- **`FileWriteArtifact`** — `{ filePath: string | null; content: string; language: string | null; lineCount: number; truncatedLive?: boolean }`. Live content via the generalized `extractStreamingWriteInput`.
- **`ReadArtifact`** — `{ kind: 'read'|'grep'|'glob'|'ls'; target: string | null; pattern?: string; resultText: string | null; resultLineCount?: number; language?: string | null }`. Codex `exec_command_end` parsed read/search results normalize here too (`parsedCmd[0].type`).
- **`WebArtifact`** — `{ kind: 'search'|'fetch'|'open_page'|'find_in_page'; query?: string; queries?: string[]; url?: string; pattern?: string; resultText: string | null }`. Sources: Claude WebSearch/WebFetch inputs; Codex `webSearchAction` live metadata AND the rollout-synthesized committed `web_search` tool_use — same VM, killing the live/committed drift.
- **`AgentSpawnArtifact`** — wraps the existing `SubAgentState` (unchanged — `TaskSubagentRow` is the one already-good card; it gets re-skinned, not redesigned) `+ { childProvider?: string }`. Spawn-tool matching fixed to include Claude `Task`.
- **`TodoArtifact`** — `{ todos: Array<{ content; status: 'pending'|'in_progress'|'completed'; activeForm }> }` (Claude TodoWrite + semantic `SemanticTaskSnapshot`).
- **`McpArtifact`** — `{ server: string; tool: string; params: unknown; paramsJson: string; resultText: string | null; resultJson?: unknown }` (parsed from `mcp__server__tool` names).
- **`SlashCommandArtifact`** — `{ name: string; message?: string; stdout?: string; args?: string }` parsed from the `<command-name>`/`<command-message>`/`<local-command-stdout>` envelope in user entries.
- **`ImageGenArtifact`** — Codex `imageGeneration` metadata `{ status; revisedPrompt?; result }`.
- **`GenericToolArtifact`** — `{ toolName: string; prettyName: string; headline: string | null; params: unknown; paramsJson: string; parseError?: string; resultText: string | null; resultIsJson: boolean }`. The ONE fallback, used identically for live and committed. Headline logic merged from `helpers.ts` + `jsonToolPresentation.ts`.
- **`ProseArtifact`**, **`ThinkingArtifact`** (`{ text; track?: 'summary'|'full'; redacted?: boolean }` — covers Codex reasoning summary/full and Claude `redacted_thinking` with an explicit "redacted" pill), **`ImageArtifact`** (`{ src: string; sourceKind: 'base64'|'url'; mediaType?: string }` — url sources become real `<img>`s), **`SystemArtifact`**, **`CompactionArtifact`**.

**Derivation rules:**

- `resolveArtifact(item, ctx)` is pure and total: every `FeedRenderItem` yields exactly one VM (entry items may yield a list — one per content block, as `ConversationRow` does today). Unknown tool names yield `GenericToolArtifact`; unknown block kinds yield `ProseArtifact` with whatever text exists (mirroring the ledger's `rendered_fallback_dev_only` philosophy: show, never hide).
- **Reference stability:** resolution is cached per item — keyed on the `FeedRenderItem` object identity plus `toolIndexVersion` (committed pairing can move) plus the `SemanticLiveTurn` reference for live items. Same inputs ⇒ same VM by reference. This is the D11 obligation of the new layer and gets the same "no-op in ⇒ identical reference out" treatment as the adapter caches.
- **No decisions:** derivation never hides anything. Collapsed-activity units, work indicator, and empty states arrive pre-decided from the ledger/bridge and map to their own row types unchanged.

---

## 5. Streaming primitives

### 5.1 `StreamingCodeBlock`

The centerpiece. Requirements:

- **Sealed-line cache:** input text is split at `\n`. Every fully-received line is highlighted once via `hljs.highlight(line, { language, ignoreIllegals: true })` and cached by line index; a sealed line never re-tokenizes (streaming text is append-only). Rendered as one `<span class="line">` per line with `dangerouslySetInnerHTML`, inside a single `<pre>`. *(Implementation note: highlight.js v11 removed the v10 `continuation` parameter, so per-line highlighting is stateless — multi-line constructs (template literals, block comments) may tint imperfectly mid-stream. This self-repairs at finalize, when the committed path does its one-shot whole-text highlight; the trade is documented in the component header.)*
- **The live tail line** re-renders per delta (tiny — one line of tokenization).
- **Stable identity:** keyed by `blockIndex` (or artifact id) alone. Language arriving late is a prop change: it invalidates the cache from line 0 once (cheap — happens within the first few deltas) but never remounts the component.
- **Language resolution:** explicit fence/file-path language wins; else defer auto-detection until either 10 sealed lines or finalize, then run `highlightAuto` once and re-seal (one-time cost, no per-delta autodetect).
- **Finalize is a no-op visually:** the last line seals; status flips on the parent card. No swap to a different component. Committed re-render of the same content produces identical DOM (streaming ≈ final).
- **Caps:** live blocks over a threshold (e.g. 2,000 lines) stop sealing with highlight and fall back to plain sealed lines (still append-only) — matching the existing `highlight={false}` O(bytes²) caution; the committed/expanded view can still offer full highlight or Monaco.
- Reused by: prose open fences, `FileWriteCard` live content, `FileEditCard` pre-parse raw input, `GenericToolCard` params-as-JSON live view (language `json`).

### 5.2 `SegmentedMarkdown`

- Splits streaming text at fence boundaries into **closed segments** + **open tail**. Each closed segment renders through the existing `ReactMarkdown` pipeline inside a `memo` whose key is the segment text — a closed segment never re-parses (fixes both the O(len²) reparse and the "second fence re-parses the first" defect in `splitStreamingCodeFence`).
- The open tail: prose → lightweight streaming renderer (the `remark-breaks` behavior preserved for line-break fidelity); open fence → `StreamingCodeBlock`.
- On finalize, the whole text renders once through the normal committed markdown path — which produces the same visual output by construction (same fence renderer underneath: `MarkdownCode` routes to `CodeView`, which shares highlight output with sealed `StreamingCodeBlock` lines).
- Segment boundary detection must handle the `splitStreamingCodeFence` edge cases: fence markers inside inline code, `~~~` fences, indented fences (keep the current conservative triple-backtick-only heuristic — documented as such).

### 5.3 `AnsiText`

- A small SGR parser: supports color (16/256/24-bit), bold, dim, italic, underline, inverse, reset. NOT a terminal emulator: no cursor movement, no clear-line — those sequences are stripped. (Carriage-return progress bars collapse to their final line: on `\r` without `\n`, keep only the last segment — this makes spinners/progress output readable instead of garbage.)
- Output: an array of styled `<span>`s; colors map to the app's terminal theme tokens (`xtermTheme.ts` palette) so output matches the real terminal's look in both light/dark themes.
- Used by `OutputWell` for all command output, live (per-delta append — parse is incremental, carrying open-style state exactly like the highlight continuation) and committed.

### 5.4 `OutputWell`

- The single collapsible output region replacing both `TruncatedOutputRow`s: first N lines visible (default 3, expandable), max-height with internal scroll when expanded, monospace, `AnsiText` content, error tint driven by the VM's status, byte/line caps with an explicit "… truncated (N more lines)" affordance — never a silent cut.

### 5.5 `DiffView`

- `DiffSlab` successor: per-file header (path, action badge Add/Update/Delete, move target, ± line counts), per-line red/green tint with per-line syntax highlight (keyed by file extension, same mechanism as today's `DiffSlab.tsx:37-48`), collapsible per file for multi-file patches, long-diff windowing (first/last K lines with an expander). Consumes precomputed `DiffLine[]` from extractors — the component never diffs.

---

## 6. Card specifications

Shared chrome (`ArtifactCard`): marker column continuation (`⎿`-aligned), header row = icon + title + `StatusBadge` + `MetaChips`, body slot, expand affordance where applicable. Streaming cards show a subtle activity shimmer on the status badge only (no layout shift on completion). All cards render identically for `plane: 'committed' | 'live'` — provenance is debug metadata only.

- **`CommandCard`** — header `$ <command>` (intelligent middle-truncation at 2 lines, click-expand for full, copy button), chips: cwd (basename with full-path tooltip), description, duration, yield/max-tokens (Codex). Body: `OutputWell` streaming ANSI output. Completion: `✓` or red `exit N` badge + duration. **Silent successes render as the compact header-only row** (command + ✓) instead of being dropped — the drop currently happens in Codex rollout synthesis (`rollout.ts:283`); the renderer requests the un-dropped form (see §8 note on the one upstream tweak this needs). Git-intent interception (`GitCardRow`) is preserved ahead of family routing, re-skinned on the kit. `write_stdin` inputs attach to the parent exec card as a "stdin →" chip-line rather than a separate naked row.
- **`DiffCard`** — `DiffView` body; Claude Edit/MultiEdit (old/new string diff) and Codex apply_patch (patch grammar) look identical. Live: shows file path as soon as the key closes + raw streaming input in `StreamingCodeBlock` until the input parses, then flips to the real diff (same card, body swap gated on parse success — the one allowed internal transition, since a partial diff is unparseable by nature). Codex `patch_apply_end` success now renders a compact "patch applied ✓ (N files)" confirmation; failure renders the error + unified_diff through `DiffView`'s line tinting (fixing the flat-colored `CodeBlock language="diff"` path).
- **`FileWriteCard`** — header: file path + language pill + growing line count. Body: `StreamingCodeBlock` (live-highlighted line-by-line — the upgraded Write preview). Committed: same component, `CodeView` semantics, expandable, "open in Monaco" affordance on desktop.
- **`ReadCard`** — collapsed one-liner ("Read `src/foo.ts` — 240 lines" / "Grep `pattern` in `src/` — 12 matches") with `ExpandSection` body: `CodeView` with line numbers honoring the `N→` prefix stripping that exists today. Glob/LS: file-list rendering (monospace list, icons via `vscode-icons-js`).
- **`WebCard`** — search: query pill + result summary text; fetch/open_page: URL (clickable, external-nav-safe per the existing link-safety rules) + result excerpt in `ExpandSection`. One card for Claude and Codex variants.
- **`AgentCard`** — `TaskSubagentRow` re-skinned on kit chrome; behavior preserved (live status glyph, elapsed, tool counts, `SubagentMiniFeed`, notification join). Spawn matching fixed: Claude `Task` | `Agent`.
- **`TodoCard`** — TodoRow re-skinned; live `SemanticTaskSnapshot` and committed TodoWrite render identically; completed-item strikethrough, in-progress spinner on the active item.
- **`McpCard`** — server pill + tool name; params as collapsible pretty JSON (`StreamingCodeBlock` json while live); result: JSON → structured slab, text → `OutputWell`, honoring existing caps but with explicit truncation notices.
- **`SlashCommandRow`** — user-plane row: `/name` pill + message text; `<local-command-stdout>` in a collapsed `OutputWell`. No more raw XML.
- **`GenericToolCard`** — the single fallback: pretty name (MCP-aware), headline (merged heuristic: `command → file_path → path → notebook_path → pattern → query → url → description`), params `ExpandSection` (pretty JSON, live-streaming safe), result via JSON slab or `OutputWell`. Identical live/committed by construction.
- **`ThinkingBlock`** — one renderer for both planes (kills the live/committed duplicate JSX); Codex reasoning summary/full tracks as tabs-in-place; `redacted_thinking` gets an explicit "redacted by provider" pill instead of an empty fallthrough.
- **`ImageBlockRow` successor** — base64 AND url sources; click-to-zoom lightbox (simple overlay, no dependency).
- **`SystemRow` successor** — hooks (`PreToolUse`/`PostToolUse`) get name + matched-tool + collapsible payload; permission-mode switches get a one-line pill; remains hidden-by-default per current Feed rule, but *renders well* when shown.
- **Usage/cost:** `Message.usage` renders as an optional per-turn hover affordance on the assistant marker (token counts, cache hits) — data currently dropped entirely; gated behind the existing debug/settings surface rather than always-on chrome.

---

## 7. The painter shell

- `Feed.tsx` becomes a thin orchestrator: `renderItems.map` → row switch (`entry` → per-block VM rows, `semantic-block`/`semantic-text` → VM rows, `semantic-collapsed-activity` → receipt row unchanged, `work` → `WorkIndicator` unchanged, `empty` → placeholder). All scroll/lazy/sticky/debug behaviors move to `ui/hooks/` — **ported with logic verbatim** (each hook's header comment cites the Feed.tsx region it came from and why it's shaped that way; the sticky-bottom, scroll-persistence, and lazy-window logic are scarred code and must not be "improved" during the move).
- `WorkIndicator` keeps its `streamPhase`-driven contract; its tool-hint vocabulary is enriched from the VM registry (per-family verbs: "Running `npm test`", "Editing `foo.ts`", "Searching the web") — display-only, no phase-machine changes.
- Memo strategy: `Feed` stays whole-component memo; every artifact row is `memo` keyed on its VM reference; the VM cache (§4) makes those memos effective. The tool-index context clone-on-version-bump behavior is preserved.

---

## 8. Migration & rollout

Each phase is a shippable PR that deletes what it replaces (opportunistic cleanup, no long-lived duplication). No feature flags — visual changes ship directly; the corpus gates structural regressions.

1. **Phase 1 — primitives:** `kit/` lands with `StreamingCodeBlock`, `SegmentedMarkdown`, `AnsiText`, `OutputWell`, `StatusBadge`, `ExpandSection`. Immediate surgical swaps inside the existing rows: live fence Monaco → `StreamingCodeBlock`; `StreamingProse` internals → `SegmentedMarkdown`; both `TruncatedOutputRow`s → `OutputWell` (ANSI on). Fixes the worst jank before any structural change.
2. **Phase 2 — painter shell:** new thin `Feed.tsx` + `ui/hooks/` ports. Pixel-parity goal; no card changes. Debug emission verified against a saved bundle before/after.
3. **Phase 3 — artifact layer + the big two:** `resolve/` + `artifacts/types.ts` + `CommandCard` + `GenericToolCard`. Both dispatch ladders start draining; live/committed generic drift ends here. Includes the slash-command envelope parser and `SlashCommandRow` (it's user-plane, cheap, high-visibility).
4. **Phase 4 — code artifacts:** `DiffCard`, `FileWriteCard`, `ReadCard`, `TodoCard`. `DiffSlab`/`ClaudeRows`/`CodexRows` JSX deleted; extractors move to `providers/*/renderer/extractors.ts`.
5. **Phase 5 — the rest + deletion:** `WebCard`, `AgentCard` (with the `Task` fix), `McpCard`, `ImageGenCard`, thinking/image/system/compaction re-skins, usage hover. Delete `Block.tsx` ladder, `BlockRow.tsx` ladder, `JsonToolRow`, `ToolUseRow`, remaining legacy rows. Update `rendering-system.md` §5 (RENDER stage) in the same PR.

**One acknowledged upstream tweak (not RENDER-layer):** rendering silent-success commands requires Codex rollout synthesis to stop dropping `exit 0` empty-output results (`rollout.ts:283`). That is a mapper change in `providers/codex/renderer/transcript/`, small and additive (emit a minimal result block instead of `[]`), and lands with Phase 3. It changes committed candidates, so it runs the corpus and any divergence is triaged honestly, per the discipline. If triage shows it perturbs ledger fixtures beyond additive rows, it ships as its own reviewed PR first.

**Remote client:** phases 1–2 automatically apply (same `<Feed>`). A phone-side visual pass happens at each phase's end (kit is browser-pure; Monaco affordances hidden on the phone host via the existing host distinction in `SessionFeed` context).

---

## 9. Verification

Per phase: `tsc` on both projects (`tsconfig.node.json` + `tsconfig.web.json` — build/vitest don't type-check), full vitest run (unit + bundle corpus + recording corpus must stay green; any corpus divergence triaged with a `why`, never blessed blind), `npm run fixture:audit`, and a live `npm run dev` session against real Claude and Codex agents exercising: a long streaming assistant message with 2+ code fences, an Edit/MultiEdit/apply_patch burst, a Write of a 200+ line file, a colored `npm test` run (ANSI + exit code), a failing command, a web search, an MCP call, a subagent spawn, a slash command, and a provider switch mid-session (transcript translation renders through the same committed path). Performance check: the existing performance panel + a before/after on the "long session + active stream" scenario (frame drops during streaming are the metric that motivated the whole rewrite).

## 10. Risks & mitigations

- **hljs continuation-state API stability** — `continuation` is semi-documented; pin behavior with a scratch harness during Phase 1 development and encapsulate it entirely inside `StreamingCodeBlock` so a future engine swap (e.g. Shiki) is one file.
- **Scroll-behavior fidelity** — mitigated by port-not-rewrite, hook-by-hook, with the region-of-origin cited; phase 2 is deliberately pixel-parity-only so scroll bugs are attributable to the move alone.
- **Corpus perturbation from the rollout tweak** — isolated to one additive mapper change; own-PR escape hatch.
- **Phone bundle growth** — kit is dependency-free (hljs already ships); Monaco stays desktop-lazy; verify remote-client bundle size in phase 1 CI output.
- **Visual regressions invisible to tests** — accepted: visual quality is exactly what tests here don't gate (by repo rule, no new test files). The mitigation is the per-phase live checklist above and small, reviewable phases.
