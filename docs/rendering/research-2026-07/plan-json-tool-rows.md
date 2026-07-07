# Plan: Generic JSON / MCP / Custom Tool-Call Row Rendering

Research date: 2026-07-07. Sources: 4 debug bundles under
`~/.config/agent-code/debug-bundles/manual/`, current row code on `main`
(41e0ba4), the rendering rewrite plan
(`docs/rendering/rendering-rewrite-plan-2026-07.md`), and the slice-16
worktree (`.worktrees/rendering-slice16`, view bridge
`src/renderer/src/rendering/view/ledgerFeedItems.ts`).

---

## 1. Inventory — what has NO custom UI today (from the bundles)

### 1a. Claude MCP tools — `tool_use` blocks named `mcp__<server>__<tool>`
Bundle `2026-06-21T19-19-55-972-62432945` (note: "No rendering for JSON tool
calls… worth building a case for agent and MCP calls").

`mcp__agent_code__orchestration_create_agent` ×4 — payload:

```json
{ "kind": "claude", "runId": "pr2-design-consult",
  "title": "Consult: AUQ keystroke driver + dismissal", "role": "consultant",
  "cwd": "/Users/juliusolsson/Desktop/Development/agent-code",
  "prompt": "Design consult for Agent Code (#289 PR-2). We're making…" }
```

**What painted** (html-clean.html): the bare tool name
`mcp__agent_code__orchestration_create_agent` with NOTHING under it — the
generic `ToolUseRow` headline chain (`command → file_path → path →
notebook_path → pattern → query → url → description`) matches no key of any
MCP input, so the body is empty. The result painted as a raw one-line JSON
blob in a `<pre>`: `{"ok":true,"agent":{"sessionId":"0f6a41eb-…`.

### 1b. Codex MCP/orchestration tools — `function_call` blocks with bare names
Bundles `2026-06-24T11-54-58-903-ad91e792` ("Implement just general json
rendering for stuff like this") and `2026-06-24T12-55-50-798-7bab27ca` ("not
rendering any custom UI for json calls, MCP or any like that").

Codex-side MCP calls carry NO `mcp__` prefix — the semantic blocks have
`kind:"function_call"`, `toolName` bare, `inputJson`/`argumentsJson` (string),
`parsedInput` (object), `inputJsonValid`, later `resultContent`/`resultAt`.

- `orchestration_read_agent` ×14: `{"sessionId":"97befa87-…","maxMessages":12}`
- `orchestration_wait_agents`: `{"sessionIds":["97befa87-…"],"timeoutMs":30000,"pollIntervalMs":2000,"maxMessagesPerAgent":3}`
- `orchestration_send_prompt`: `{"sessionId":"…","prompt":"Important constraint reminder: do not modify…"}`
- `ai_workspace_create`: `{"name":"Deep Code Audit Implementation Plans","description":"All verified audit…","scope":{"project":"agent-code","runId":"deep-code-audit-2026-06-23",…}}`
- `ai_workspace_attach_file` ×18: `{"workspaceId":"4d2cf480-…","path":"/Users/…/docs/audit-plans/commands-ui-shell.md","title":"Commands UI Shell Plan","description":"Implementation plan from Commands UI Shell audit.",…}`
- `orchestration_read_run_outputs`, `orchestration_list_agents` (`{}` input → nothing to show at all)

**What painted**: `CodexToolRow` = name + ONE headline line. For
`orchestration_read_agent` the headline chain finds nothing → bare name only.
For `ai_workspace_attach_file` it shows `description` ("Implementation plan
from Commands UI Shell audit.") and HIDES the actual `path` — a real ordering
bug: `headlineForTool` (CodexRows.tsx:164-168) checks `input.description`
BEFORE `input.path`. Results painted as raw single-line blobs:
`Wall time: 0.0200 seconds\nOutput:\n[{"type":"text","text":"{\"ok\":true,\"output\":{…escaped json…}"}]`.

### 1c. Suppressed-row starvation — bundle `2026-06-23T12-45-50-654-1a616ae8`
("not showing most tool calls in rendering, only occasional updates").
Session had 9 `exec_command` + 19 `write_stdin` calls. ALL 19 `write_stdin`
had empty `chars` (poll continuations) → `CodexWriteStdinRow` returns `null`
by design (CodexRows.tsx:443-451). Only 7 `Run` rows painted. So during a
long interactive-PTY stretch the feed shows almost nothing. The generic row
doesn't fix the intentional empty-stdin suppression, but any session mixing
MCP calls with these (bundle 11-54) shows mostly-blank tool rows — same
perceived symptom.

### 1d. What ALREADY has custom UI (do not touch)
- Claude: `EditRow`, `MultiEditRow`, `WriteRow`, `TodoRow`
  (`src/providers/claude/renderer/rows/ClaudeRows.tsx`, dispatch in
  `dispatch.tsx`); `AskUserQuestionRow`, `TaskSubagentRow` (Agent/spawn_agent),
  Read/Grep result special-casing in `ToolResultRow.tsx`.
- Codex: `CodexExecCommandRow`, `CodexWriteStdinRow`, `CodexApplyPatchRow`
  (+ `DiffSlab`/`PatchFileHeader` in `src/providers/shared/renderer/rows/`),
  `CodexToolResultRow` exec/patch kinds.
- OpenCode: `todowrite` → reused `TodoRow`; everything else falls through.
- Cross-provider: `GitCardRow` interception for Bash/exec_command git commands
  (Block.tsx:124-135, behind `settings.customRendering`, default **false**).

**The gap in one sentence:** every tool that is not a file-op/shell/todo —
i.e. all MCP tools on both providers, all orchestration/workspace tools, any
future custom tool — renders as a bare name with either nothing, or one
misleading string, and its JSON result as an unformatted single-line blob.

---

## 2. Current dispatch architecture (where a fallback can slot in)

Committed rows — `src/renderer/src/features/feed/ui/rows/Block.tsx`:

```
case 'tool_use':
  … GitCardRow interception … TaskSubagentRow interception …
  const providerRow = getRendererProviderCapabilities(currentProvider).renderToolUse?.(tu)
  return providerRow !== undefined ? providerRow : <ToolUseRow block={tu} />   // ← THE fallback seam
case 'tool_result':
  const providerRow = …renderToolResult?.(tr, { sourceTool })
  return providerRow !== undefined ? providerRow : <ToolResultRow block={tr} />
```

Provider dispatch tables live in
`src/providers/{claude,codex,opencode}/renderer/rows/dispatch.tsx`, registered
via `renderToolUse`/`renderToolResult` in
`src/providers/registry.renderer.capabilities.ts`. Claude + OpenCode return
`undefined` for unknown tools (fall to shared `ToolUseRow`); **Codex claims
everything** (`return <CodexToolRow block={block}/>` for any name), which is
why the codex fallback and the shared fallback have drifted apart.

Live rows — `src/renderer/src/features/feed/ui/semantic/BlockRow.tsx`
(`SemanticLiveBlockRow`) is a parallel hand-rolled dispatch: `function_call`/
`custom_tool_call` → converts the semantic block to a `ToolUseBlock` and
reuses the committed Codex rows (fallback `CodexToolRow`); `tool_use`/
`mcp_tool_use`/`server_tool_use` → inline JSX that dumps `block.inputJson`
raw into a `<pre>` and `resultContent` into another `<pre>`. This is the
"BlockRow bypass drift" the rewrite plan kills at Stage 3 ("live tool rows
route through the SAME provider registry dispatch committed rows use").

New pipeline bridge — slice-16 worktree
`src/renderer/src/rendering/view/ledgerFeedItems.ts`: the ledger emits legacy
`FeedRenderItem`s; `type:'entry'` items still render through
`Block.tsx`, `type:'semantic-*'` still render through
`SemanticStreamingTurn`/`BlockRow`. **Consequence: any row work done on the
legacy components survives the Stage-3 cutover unchanged**, because Stage 3
swaps the decision core, not the row components.

---

## 3. Design

### 3a. One shared generic JSON tool row
New file `src/providers/shared/renderer/rows/JsonToolRow.tsx` (next to
`DiffSlab.tsx` — the established home for cross-provider row primitives).

Committed/final shape:

```
⏺ orchestration_create_agent   MCP · agent_code        ← prettified name + muted badge
  ⎿ title: "Consult: AUQ keystroke driver + dismissal" ← smart headline (see below)
  ⎿ ▸ 6 params (click to expand)                       ← collapsed <details>
      {                                                ← pretty JSON, hljs json,
        "kind": "claude",                                 paths/urls linkified
        "cwd": "~/Desktop/Development/agent-code",     ← formatToolFilePath display,
        …                                                 raw path in title tooltip
```

Pieces:

1. **Name prettification** — `mcp__<server>__<tool>` → display `<tool>` with
   a muted `MCP · <server>` badge (claude naming); bare codex names stay
   as-is (codex strips the prefix upstream, nothing to detect). Pure helper,
   ~15 lines.
2. **Smart headline** — unify the two existing chains (`ToolUseRow.pickString`
   chain + Codex `headlineForTool`) into one, with `path`-shaped keys
   (`file_path`, `path`, `notebook_path`, `url`) checked BEFORE
   `title`/`name`/`prompt`, and `description` last (fixes the
   `ai_workspace_attach_file` description-over-path bug). Add `title`,
   `name`, `prompt`, `sessionId` as recognized keys — those are what MCP
   payloads actually carry (evidence above).
3. **Collapsible JSON slab** — `<details>` closed by default (matches the
   thinking-row and Read-result precedent), summary `▸ N params`. Body:
   `JSON.stringify(input, null, 2)` through the existing `CodeBlock`
   (`language="json"`, hljs engine — one-shot highlight is fine for committed
   rows; pass `highlight={false}` on the live path, same O(bytes²) rationale
   as the Write streaming preview in BlockRow.tsx:494-505). Cap rendered JSON
   at ~200 lines / 16KB with the `TruncatedOutputRow`-style "+N lines"
   expander so a 50KB prompt param can't wreck the feed.
4. **Path/URL linkification** — post-process the highlighted output is
   fragile; instead render string values whose text matches
   `/^(~|\/)[^\0]*/` (absolute path) via `formatToolFilePath(path,
   workspaceRoot)` (already in `@shared/paths/displayPath`, used by
   CodexRows) with the raw path in `title`, and `https?://` values as
   `<a>`. Simplest robust shape: a tiny custom key-value renderer for the
   TOP level (key, primitive value with path/url detection) and plain
   pretty-JSON `CodeBlock` for nested objects — this covers every payload in
   the corpus (all are 1-2 levels deep) without writing a JSON tree widget.
5. **Result slab** — shared `tryExtractJson(text)` helper:
   (a) unwrap the MCP text envelope `[{"type":"text","text":"<json>"}]` one
   level, (b) unwrap codex's `Wall time: …\nOutput:\n<json>` wrapper,
   (c) `JSON.parse` the remainder; on success render collapsed pretty JSON
   (summary: `ok:true` / `ok:false` / `N keys`), on failure fall through to
   the existing `TruncatedOutputRow`. Error styling: keep `is_error` →
   `text-danger` exactly as today; additionally style the summary line danger
   when the parsed object has `ok === false` (cheap, evidence-backed — every
   orchestration/workspace result in the corpus carries `ok`).

### 3b. Dispatch rule — where the fallback slots in
**Rule: the generic JSON row is the SHARED feed fallback that fires when no
provider claims the tool.** Concretely:

1. `Block.tsx` `tool_use` case: replace `<ToolUseRow block={tu}/>` fallback
   with `<JsonToolRow block={tu}/>`. `JsonToolRow` internally degrades to
   exactly today's ToolUseRow look (name + one headline line) when the input
   has ≤1 meaningful field — so Bash rows (claude) keep their current
   rendering including `truncateBashCommand` (fold ToolUseRow's Bash cap into
   JsonToolRow, then delete ToolUseRow — or keep ToolUseRow as a thin wrapper;
   deleting is cleaner per the opportunistic-cleanup rule).
2. `providers/codex/renderer/rows/dispatch.tsx`: `renderCodexToolUse` stops
   claiming unknown names — keep `apply_patch`/`exec_command`/`write_stdin`
   dispatch, `return undefined` otherwise so codex MCP/orchestration tools hit
   the same shared fallback as claude's. (`CodexToolRow` stays only as the
   internal degraded fallback for unparseable exec/patch inputs, or gets the
   same JsonToolRow treatment.) This is exactly the shape the opencode
   dispatch comment already prescribes ("everything else intentionally falls
   through to the generic rows").
3. `providers/codex/renderer/rows/dispatch.tsx` `renderCodexToolResult`: in
   `CodexToolResultRow`'s final fallback (CodexRows.tsx:601-603), try
   `tryExtractJson` before `TruncatedOutputRow`.
4. Shared `ToolResultRow.tsx`: same — before the final `TruncatedOutputRow`
   (line 177), try `tryExtractJson`.
5. Live path `BlockRow.tsx` (glue only, all logic in the shared components):
   - `function_call`/`custom_tool_call` fallback (line 261
     `return <CodexToolRow…>`): → `<JsonToolRow block={liveTool} live/>`
     (live ⇒ `highlight={false}`, and only pretty-print once
     `parsedInput`/parse succeeds — partial `inputJson` keeps today's raw
     `<pre>`).
   - `tool_use`/`mcp_tool_use`/`server_tool_use` branch: the raw
     `{block.inputJson}` `<pre>` (line 514-518) and the `resultContent`
     `<pre>` (line 527-539) get the same parse-gated upgrade.
   These BlockRow edits are DELIBERATELY thin because Stage 3 deletes this
   bypass; anything smart must live in `JsonToolRow`/`tryExtractJson` so it
   survives.

`customRendering` flag: do NOT gate the JSON row behind it. That flag gates
the git-widget interception (an opinionated replacement of Bash rows);
JSON formatting is a fidelity fix to the default fallback, and the bundles
show the default path is what users see (flag defaults to false).

### 3c. Interaction with the rendering rewrite (Stage-3 flag)
- **Lands now, against the legacy row path.** The ledger view bridge emits
  legacy `FeedRenderItem`s whose `entry`/`semantic` items render through
  Block.tsx / BlockRow.tsx — the exact components edited here. Nothing in
  this plan touches `rendering/{model,adapter,policy,shadow}`.
- Improving the committed fallback (`Block.tsx`) actually REDUCES Stage-3
  risk: when Stage 3 routes live tool rows "through the SAME provider
  registry dispatch committed rows use", the generic JSON fallback is already
  the registry-blessed shared fallback — the BlockRow glue edits (step 5) are
  the only throwaway code, ~20 lines.
- One caution for shadow mode (Stage 2 running in the slice worktrees): the
  shadow diff compares row OUTPUT signatures in some tests
  (`shadowParity.test.ts`); if those snapshot row text, landing this on main
  will need the slice branch to rebase/merge — flag it in the PR description.
  Merge-simulate against the rendering slice branch per the tsc-gate memory.

---

## 4. Tests

Corpus fixtures (the four bundles become the test cases):
- Extract the 4 `proxy-semantic.json` tool blocks into
  `testing/fixtures/rendering-bundles/`-style JSON fixtures (the slice-16
  worktree already has that corpus dir + `bundleCorpus.test.ts` harness; on
  main, put payload fixtures under `testing/fixtures/` beside its README).
  Specifically pin:
  - `mcp-claude-orchestration-create-agent.json` (bundle 06-21) — claude
    `tool_use`, `mcp__agent_code__orchestration_create_agent`.
  - `codex-orchestration-tools.json` (bundle 06-24 11:54) — 7 distinct
    orchestration_* payloads incl. the `{}`-input `orchestration_list_agents`.
  - `codex-ai-workspace.json` (bundle 06-24 12:55) — `ai_workspace_attach_file`
    (the description-vs-path headline regression case) + `ai_workspace_create`.
  - `codex-write-stdin-starvation.json` (bundle 06-23) — 19 empty write_stdin
    + exec_command mix (guards that the generic row does NOT resurrect empty
    stdin rows; suppression stays).

Unit tests pinning payload→row mapping (policy note: the no-new-test-files
rule is formally exempted for the rendering project; if this lands as a
standalone feature PR, fold these into the existing renderer test entry
points rather than minting new `test:*` scripts — the pattern to copy is
`AskUserQuestionRow.feed.renderer.test.tsx`, vitest + @testing-library):
1. `jsonToolPresentation` (pure helpers, no React): name prettify
   (`mcp__a__b` → `b` + badge; bare names untouched), headline priority
   (path beats description; command beats all), `tryExtractJson` (MCP text
   envelope, codex Wall-time wrapper, plain JSON, non-JSON passthrough,
   `ok:false` detection).
2. `JsonToolRow` render tests: MCP payload → badge + headline + collapsed
   details containing pretty JSON; `{}` input → name-only row (no empty
   details); absolute path value → linkified display text with raw path in
   title; >200-line JSON → truncation expander; `live` + unparseable partial
   input → raw pre (no crash, no flicker).
3. Result-side: claude tool_result with envelope JSON → collapsed slab;
   codex `Wall time` result → collapsed slab; `is_error` → danger styling
   preserved.

---

## 5. Code changes, file by file

| # | File | Change | Est. size |
|---|------|--------|-----------|
| 1 | `src/providers/shared/renderer/rows/jsonToolPresentation.ts` (new) | Pure helpers: `prettifyToolName`, unified `toolHeadline`, `tryExtractJson` (envelope/wall-time unwrap), path/url token detection | ~140 lines w/ WHY comments |
| 2 | `src/providers/shared/renderer/rows/JsonToolRow.tsx` (new) | `JsonToolRow` (header + headline + collapsible top-level key-value + nested `CodeBlock language="json"`), `JsonResultSlab` | ~220 lines |
| 3 | `src/renderer/src/features/feed/ui/rows/ToolUseRow.tsx` | Fold Bash truncation into JsonToolRow and delete, or reduce to re-export; `rows/index.ts` update | −60 / +10 |
| 4 | `src/renderer/src/features/feed/ui/rows/Block.tsx` | Fallback `<ToolUseRow>` → `<JsonToolRow>` | ~5 |
| 5 | `src/providers/codex/renderer/rows/dispatch.tsx` | Unknown tool names return `undefined` (stop claiming); result fallback comment | ~10 |
| 6 | `src/providers/codex/renderer/rows/CodexRows.tsx` | `CodexToolResultRow` final fallback tries `JsonResultSlab`; fix/remove `headlineForTool` description-before-path; `CodexToolRow` degraded fallback → JsonToolRow | ~40 diff |
| 7 | `src/renderer/src/features/feed/ui/rows/ToolResultRow.tsx` | Final fallback tries `JsonResultSlab` before `TruncatedOutputRow` | ~15 |
| 8 | `src/renderer/src/features/feed/ui/semantic/BlockRow.tsx` | Live glue: function_call fallback + tool_use raw-pre + result-pre parse-gated upgrade to shared components (throwaway at Stage 3, keep thin) | ~35 diff |
| 9 | Fixtures + tests (see §4) | 4 payload fixtures + 2 test files | ~120 fixtures, ~250 tests |

Total: ~2 new files, 6 edits, one worktree-branch PR (`.worktrees/<name>` per
convention). Verification: raw `tsc` on both projects + merge-simulate against
`feat/rendering-slice16-triage`.

**Can land now:** everything above (items 1-9) — it's all legacy-row-path and
registry-dispatch work that Stage 3 explicitly preserves.
**Must wait for Stage 3:** nothing in this plan; the only Stage-3-coupled
piece is DELETING the BlockRow live glue (item 8) when SemanticStreamingTurn
dies, and any move of rows into `rendering/view/` dumb-row form — do not
pre-build that.

## 6. Open questions for the caller
- Should the generic row attempt result-JSON rendering for `ok:false` danger
  highlight, or keep strictly `is_error`? (Plan says yes-cheaply; cut if it
  smells like enforcement bloat.)
- Empty-input tools (`orchestration_list_agents` `{}`): bare-name row (plan)
  vs suppressing entirely like empty write_stdin? Bundles suggest bare-name
  is right — the call is user-meaningful even with no args.
