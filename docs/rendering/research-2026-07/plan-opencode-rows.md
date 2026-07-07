# OpenCode rendering gaps — plan from the three 2026-07-06 bundles

Research pass for the rendering rewrite. Sources: the three manual debug bundles under
`~/.config/agent-code/debug-bundles/manual/`, the opencode-headless dispatcher, the
app-side opencode mapper, and the renderer row layer. All paths absolute; worktree-only
files (`.worktrees/rendering-slice16/`) flagged.

- `2026-07-06T15-50-54-393-e8e82431` — "Rendering is not really developed properly for opencode"
- `2026-07-06T16-52-30-584-87f0eeef` — "We are getting somewhere, got a fuck ton of rendering to handle"
- `2026-07-06T16-54-13-861-87f0eeef` — "another glitch when writing.... agent output seems to break stuff?"

Status caveat: the bundles predate several fixes ALREADY in the pipeline (blockless
text / reasoning glue, `'tool'`→`'tool_use'` kind, duplicate-user-row capability gate,
child-session identity theft, the stuck-"Sending" phase bridge). Those are "verify with
fixture" items, not work items. The remaining REAL gaps are almost entirely in the ROW
layer: opencode's lowercase tool vocabulary and raw payload formats fall through to
name-only headers and raw `<pre>` dumps.

---

## 1. Gap inventory (with bundle evidence)

### Bundle 1 — 15:50 (session e8e82431) — mostly historical

Captured before the current mapper: `proxy-semantic.json` log has ONLY `turn_delta`
×199 + `turn_completed` ×1 — no `turn_started`/`block_started`/`stream_phase`;
`state-snapshot.json` has `totalEntries: 0` (nothing ever committed).

- **G1 (FIXED — verify): reasoning glued into answer text.** One prose block, no
  separator — note the `do!I can help` join:

  ```
  **Clarifying my abilities**
  I need to provide a simple yet skill-invoking answer ... to ensure the user
  understands what I can do!I can help with most software work in this repo…
  ```

  Cause (documented at `packages/opencode-headless/src/dispatcher/EventDispatcher.ts:29-39,712-720`):
  opencode reasoning deltas arrive with `field:"text"`; routing now keys on the
  registered part-kind map. Bundles 2/3 already show a separate collapsible
  "∴ Thinking" row.

- **G2 (FIXED — verify): stuck `Sending · 41s`.** `streamPhase: "submitting"` with
  `processActive: false`, `sessionStatus: "idle"`. Opencode emits no `stream_phase`
  events, and the machine only advanced on them. Fixed by the provider-agnostic
  turn-lifecycle bridge in
  `src/renderer/src/workspace/semantic/streamPhaseMachine.ts:100-152`
  (`turn_started` → `responding`, `turn_completed` → `idle` when nothing pending).
  Bundle 2 (`idle`) and bundle 3 (`responding` mid-turn) confirm the bridge working.

### Bundle 2 — 16:52 — the "fuck ton of rendering" bundle (turn finished cleanly, `idle`, 9 entries)

- **G3 (fix landed — verify): duplicate user row.** `entry:optimistic-codex-user:1783356732236`
  AND committed `entry:msg_f385833b1001ooVUN3uabWeINj` both paint the identical
  prompt. The capability gate fix
  (`src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts:1448-1461`,
  `usesOptimisticUserEcho`) landed after capture. **Residual risk stays open**: the
  entries-plane reconciliation matches by EXACT text `===`
  (`useIpcSubscriptions.ts:1499-1516,1569-1576` via `entryTextContent`,
  `src/renderer/src/workspace/entries/utils.ts:16-27`); the NFKC/whitespace-tolerant
  comparator (`streaming.ts:85-99`) is only used for queuedMessages. Any CRLF/unicode
  divergence in opencode's echo re-introduces the double row.

- **G4: tool_use rows are bare lowercase names, no argument summary.** `skill`,
  `todowrite`, `read` render as just `⏺ skill` etc. The inputs are rich (semantic
  `tool_input_finalized` events):

  ```json
  {"name":"skill",     "input":{"name":"dispatching-parallel-agents"}}
  {"name":"todowrite", "input":{"todos":[{"content":"Map repository structure…","status":"in_progress","priority":"high"}, …]}}
  {"name":"glob",      "input":{"pattern":"**/package.json","path":"/Users/juliusolsson/Desktop/Development/agent-code"}}
  {"name":"read",      "input":{"filePath":"…/src/renderer/src/app-state/types.ts","offset":1,"limit":220}}
  ```

  Why: `renderOpencodeToolUse` handles only `todowrite`
  (`src/providers/opencode/renderer/rows/dispatch.tsx:24-31`); everything else falls
  to generic `ToolUseRow`, whose headline chain
  (`src/renderer/src/features/feed/ui/rows/ToolUseRow.tsx:48-56`) probes
  `command → file_path → path → notebook_path → pattern → query → url → description`
  — opencode uses camelCase `filePath` (miss → bare `read` header) and `name` for
  skill (miss).

- **G5: glob headline shows the cwd instead of the pattern.** The three parallel
  `glob` rows each show `⎿ /Users/juliusolsson/Desktop/Development/agent-code`. Not a
  stray result: the headline chain hits `path` (opencode's cwd arg) BEFORE `pattern`.
  Claude's `Glob` uses `path` only as optional scope, so the ordering never hurt
  before.

- **G6: tool results dump raw opencode payload text.** Results commit as separate
  user entries `msg_…:result:call_…` (correct Claude-mirror shape) but content is
  opencode's native text, and `renderOpencodeToolResult` returns `undefined`
  (dispatch.tsx:39) → generic `ToolResultRow`, whose rich branches key on
  capitalized `sourceTool` (`Read`/`Grep`/`Edit`/`Write`/`TodoWrite`,
  `ToolResultRow.tsx:90-170`) → opencode always lands in `TruncatedOutputRow`
  (line 177). Observed raw paints:

  - `read` → `<path>…</path>\n<type>file</type>\n<content>\n1: import …` (line-numbered
    `N: ` body in XML-ish tags) shown as escaped tag soup + "+100 lines".
  - `todowrite` → the JSON array `[{"content":…,"status":…,"priority":…}]` printed as
    JSON, even though the INPUT already rendered as a TodoRow checklist above it —
    should be suppressed like Claude's TodoWrite results (ToolResultRow.tsx:90-98).
  - `skill` → raw `<skill_content name="dispatching-parallel-agents">…` dump.
  - `glob`/`list` → raw newline path list (tolerable, but no "N files" summary).

### Bundle 3 — 16:54 — the "agent output breaks stuff" bundle (mid-turn, parallel subagents)

All of bundle 2's gaps, plus:

- **G7 (FIXED — verify): child-session turn spasm + mid-word text split.** 20 semantic
  history turns, 17 EMPTY (`text:''`, `blockOrder:[]`); 30 `turn_started`/`turn_completed`
  pairs in the last 200 log events — `task` child-session events on the server-wide
  `/event` SSE minted ghost turns and re-opened the parent turn. The visible symptom:
  `hist[18].text = '/src/main/session'` and `currentTurn.text = 'Manager.ts\`…'` —
  SAME turnId `msg_f3859cd7c…` — painting a paragraph starting `Manager.ts\``
  (html-clean.html:605). Fixed by adopt-only session filter
  (`EventDispatcher.ts:132-142,454-466`) + `ensureBlockOpen`/`closeOpenBlocksForTurn`
  (`EventDispatcher.ts:610-611,1028-1032`). Already pinned by the worktree test
  `fixtures.opencodeInterleave87f0eeef.test.ts` (render-exactly-once invariant).

- **G8: task/subagent activity is invisible.** Model dispatched parallel agents; the
  27 committed entries contain NO `task` tool_use row (visible_rows: only
  skill/todowrite/glob/read + results). Two layers: (a) Block.tsx subagent
  interception gates on `name === 'Agent' || 'spawn_agent'`
  (`src/renderer/src/features/feed/ui/rows/Block.tsx:137-144`) — lowercase `task`
  misses; (b) the parent assistant message carrying the task parts commits only on
  `info.time.completed`, which for long-running subagents is the END of the whole
  turn — so during a subagent fan-out the feed shows nothing at all. Needs a fresh
  probe capture to confirm the `task` part shape (`input.description`, child
  `sessionID` in metadata?) before wiring `TaskSubagentRow`.

- **G9: scary plumbing banner for an expected condition.** Footer paints
  `transcript unavailable: Ignored JSONL from provider session ses_0c7a71f60ffe…
  because this pane is bound to ses_0c7a7ccabffe…`
  (`useIpcSubscriptions.ts:1230`, decision from
  `src/renderer/src/workspace/providerSessionIdentity.ts:110`). For opencode a
  child-session burst is EXPECTED during task fan-out, not a transcript failure —
  it should be a silent (or debug-only) drop when the observed session is a child of
  the bound one.

- **G10: git widget + Bash niceties miss lowercase `bash`.** Block.tsx:124-135 gates
  `GitCardRow` on `name === 'Bash' || 'exec_command'`; opencode's `bash` never gets
  git cards (no bundle evidence of a bash call in these three captures — flagged from
  code reading; confirm with a fresh capture).

- **G11: shared fold layer misses lowercase names.**
  `src/renderer/src/workspace/semantic/helpers.ts:358` checks
  `block.toolName === 'TodoWrite'` — opencode's `todowrite` silently skips any
  Claude-name-gated fold behavior (todo/task panel extraction).

Wire-shape reference (bundle 3 `tool_result` semantic events):

```json
{"type":"tool_result","toolUseId":"prt_f385a0849001PGfHh5eBzBD1uF","name":"read",
 "content":"<path>/…/types.ts</path>\n<type>file</type>\n<content>\n1: import type { Settings } …"}
{"type":"tool_result","toolUseId":"prt_f385a082a001NqTys2cQBGUKmC","name":"glob",
 "content":"/…/global-editor/store.ts"}
```

Live plane keys tool blocks by `prt_…` part ids; committed entries use `call_…`
callIDs — mapper prefers `part.callID` so resume/live uuids align
(`src/providers/opencode/renderer/transcript/mapper.ts:117`).

---

## 2. Pipeline facts the design leans on (verified in source)

- **Committed entries ARE Claude-shaped.** `mapOpencodeMessageToFeedEntries`
  (`src/providers/opencode/renderer/transcript/mapper.ts:56`) emits one
  `{type: role, message:{role, content:[…]}}` entry (uuid = opencode `msg_…` id) plus
  one separate `user` tool_result entry per tool part (uuid
  `${messageId}:result:${callId}`, mapper.ts:127-138,169-186). The Claude row stack
  can therefore render opencode entries as-is; the deltas are only (a) tool NAME
  casing, (b) input key schemas, (c) result payload text formats.
- Ghost gating: assistant messages without `info.time.completed` are dropped from the
  committed plane (mapper.ts:76-83); `committedAssistant` set prevents resurrection
  (EventDispatcher.ts:518-521).
- Kind normalization done: `'tool'`→`'tool_use'`
  (`packages/opencode-headless/src/channels/types.ts:73-81`,
  `EventDispatcher.ts:1090-1110`).
- **Tool names pass through verbatim lowercase — no normalization anywhere**
  (mapper.ts:119; EventDispatcher.ts:589,887-890).
- **Tool result payloads pass through raw** (`toText`, mapper.ts:125,206-214; live:
  EventDispatcher.ts:683,1132-1137).
- Result↔use pairing is by `tool_use_id` via Feed-level side-channel maps
  (`ToolUseIndexContext`/`ToolResultIndexContext`,
  `src/renderer/src/features/feed/context.tsx:42-66`) — works across separate
  committed entries; nothing to fix there.
- Dispatch layering (`src/renderer/src/features/feed/ui/rows/Block.tsx:105-147`):
  git-widget intercept → subagent intercept → provider `renderToolUse` → generic
  `ToolUseRow`. Capabilities per provider in
  `src/providers/registry.renderer.capabilities.ts` (opencode: lines 200-216,
  "evidence-backed rows only" — todowrite is the only rich row today).
- Codex precedent: `renderCodexToolUse` never falls through to the shared generic row
  — it has its own catch-all `CodexToolRow`
  (`src/providers/codex/renderer/rows/dispatch.tsx:12-21`). Opencode can follow
  either pattern; recommendation below keeps the shared generic as final fallback.

## 3. Design — mapping table

**Decision: do NOT rename tools in the mapper.** Names are evidence (the capabilities
comment codifies this), the fold layer and dispatch can alias, and renaming would
desync committed transcripts from opencode's own session storage on resume. All
mapping happens in `src/providers/opencode/renderer/rows/dispatch.tsx` (+ small,
explicitly-aliased gates in the two shared intercepts). Reuse Claude rows wherever the
committed shape already fits; write opencode-specific parsing only for opencode-native
payload text.

| opencode tool | input evidence | tool_use row | result row | work |
|---|---|---|---|---|
| `todowrite` | `{todos:[{content,status,priority}]}` | Claude `TodoRow` (DONE, dispatch.tsx:27) | **suppress** non-error (mirror ToolResultRow.tsx:90-98) | result suppression only |
| `todoread` | none captured | generic | suppress or checklist | low priority; confirm shape |
| `read` | `{filePath,offset,limit}` | generic + headline fix (`filePath`) | parse `<path>/<type>/<content>` doc, strip `N: ` prefixes → "Read N lines" collapsed CodeBlock (mirror ToolResultRow.tsx:112-145) | new `OpencodeReadResultRow` (or shared parser + reuse) |
| `glob` | `{pattern,path}` | headline = `pattern` (G5) | "N files" summary + path list (TruncatedOutputRow fine underneath) | small |
| `grep` | not captured — probe | generic (pattern headline) | CodeBlock like Claude Grep (ToolResultRow.tsx:150-170) | confirm shape first |
| `list` | not captured — probe | generic (`path`) | tree text, truncated | low |
| `bash` | not captured — probe (`{command,description?}`) | generic (command headline works) + alias into git-widget gate (G10) | TruncatedOutputRow (fine) | alias only |
| `edit` / `patch` | **not captured — MUST probe** (likely `{filePath,oldString,newString}` / patch text) | adapt keys → Claude `EditRow` (diff) | suppress non-error | blocked on probe |
| `write` | **not captured — MUST probe** (likely `{filePath,content}`) | adapt keys → Claude `WriteRow` | suppress non-error | blocked on probe |
| `task` | **not captured mid-flight — MUST probe** | alias into subagent intercept → `TaskSubagentRow` (G8) | subagent report styling | blocked on probe + commit-latency question |
| `skill` | `{name}` | headline = `Skill(<name>)` | collapsed markdown (raw dump acceptable interim) | small |
| `webfetch` | not captured | generic (`url` headline works) | TruncatedOutputRow | none |
| `question` | not captured | AskUserQuestion-style — probe | — | post-cutover |

**Needs-new-row:** only the opencode `read` result parser/row (and possibly `task`
report styling). Everything else is aliasing + headline fixes + reuse of Claude rows.

**Upstream (packages/opencode-headless) changes: none required** for the row work.
Optional/verify items: (a) confirm `task` tool parts surface on the parent message
with child-session linkage metadata; (b) consider emitting a lightweight progress
part for still-running assistant messages so long subagent fan-outs aren't invisible
(interim mitigation: the live semantic plane already shows tool blocks — verify the
semantic card renders during fan-out). (c) `stream_phase` emission is NOT needed —
the phase bridge covers it.

**Note on the probe:** the referenced
`scratchpad/probe-opencode.mjs` does not exist (scratchpad has analyze/sweep/triage
tooling only). A fresh wire capture for `edit`/`write`/`task`/`grep`/`question` input
shapes is a prerequisite for those three table rows; `~/.config/agent-code/proxy/`
dumps are the ground-truth recording channel.

## 4. Tests / fixtures

Corpus infra is worktree-only today
(`.worktrees/rendering-slice16/src/renderer/src/rendering/__tests__/bundleCorpus.test.ts`;
fixtures in `.worktrees/rendering-slice16/testing/fixtures/rendering-bundles/`, 46
bundles, bless via `AGENT_CODE_CORPUS_BLESS=1`).

Already present there:
- `2026-07-06T16-54-13-861-87f0eeef.json` — triage `[]` (clean parity), plus the
  dedicated `fixtures.opencodeInterleave87f0eeef.test.ts` pinning the interleave
  render-exactly-once invariant (covers G7).
- `2026-07-06T16-52-30-584-87f0eeef.json` — one triaged `extraction-gap` divergence.

To add:
1. Extract `2026-07-06T15-50-54-393-e8e82431` via `scripts/extract-rendering-fixtures.mjs`
   into the corpus (covers G1/G2 history; expect triage entries for the pre-mapper
   semantic-only shape — bless + verdict them, likely `legacy-bug`).
2. Row-level unit tests (colocated with the opencode dispatch, NOT new test:* scripts
   — per repo test policy, keep additions inside the rewrite's existing test files):
   - dispatch: each lowercase name → expected row component; unknown name → generic.
   - `read` result parser: tagged-doc parse, `N: ` strip, line-count summary; error
     payloads (no `<content>`) fall back to raw.
   - `glob` headline prefers `pattern` over `path`.
   - `todowrite` result suppression (input-side TodoRow already tested).
   - optimistic-echo reconciliation: committed echo differing by CRLF/NBSP still
     supersedes (G3 residual) — extend the existing reconciliation test.
   - fold alias: `todowrite` triggers the TodoWrite fold path (helpers.ts:358).
3. After the probe capture: fixture a turn containing `edit`/`write`/`task` and pin
   EditRow/WriteRow/TaskSubagentRow selection.

## 5. Code changes, file-by-file

### Pre-cutover (safe on main now; all files shared by legacy Feed and the rewrite's row layer)

1. `src/providers/opencode/renderer/rows/dispatch.tsx`
   - Extend `renderOpencodeToolUse`: `skill` headline row, `glob` pattern-first
     headline (opencode-specific `ToolUseRow` wrapper passing an explicit headline,
     or a tiny `OpencodeToolRow`), keep default → `undefined` (shared generic stays
     the final fallback — unlike codex's own catch-all, so future opencode tools
     still render something sane).
   - Implement `renderOpencodeToolResult`: `read` parser row, `todowrite`/`edit`/
     `write` non-error suppression, `glob`/`list` count summary; default `undefined`.
2. `src/renderer/src/features/feed/ui/rows/ToolUseRow.tsx` — add `filePath` to the
   headline chain after `file_path` (harmless for other providers; camelCase is
   opencode-only today). Alternative: keep the chain untouched and do it in the
   opencode wrapper — decide by taste, but ONE place only.
3. `src/renderer/src/features/feed/ui/rows/Block.tsx` — add `'task'` to the subagent
   intercept (lines 137-144) and `'bash'` to the git-widget gate (lines 124-135),
   with WHY comments naming opencode's lowercase vocabulary. (Task row itself may
   need input-key adaptation — blocked on probe.)
4. `src/renderer/src/workspace/semantic/helpers.ts:358` — accept `todowrite` alias
   (case table, not `.toLowerCase()` blanket — keep evidence-based).
5. `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts:1499-1516,1569-1576` —
   use the normalized comparator (`codexPromptsMatchForOwnership`-style) for the
   entries-plane optimistic reconciliation, not exact `===` (G3 residual).
6. `src/renderer/src/workspace/providerSessionIdentity.ts` (+ banner emit at
   `useIpcSubscriptions.ts:1230`) — downgrade `conflicting-provider-session` to a
   silent/debug drop for opencode child-session bursts instead of the persistent
   "transcript unavailable" footer (G9). Gate on provider capability, not kind
   string, per the plug-and-play direction (#394).

### Post-cutover (rewrite worktree / after ledger lands)

7. `.worktrees/rendering-slice16/testing/fixtures/rendering-bundles/` — add the
   15:50 bundle fixture; re-bless the two existing opencode fixtures after the
   dispatch changes (row keys unchanged — triage should stay empty/1; any new
   divergence is a regression signal).
8. `src/renderer/src/rendering/` ledger — no opencode-specific changes expected
   (committed entries are Claude-shaped and the interleave fixture already passes);
   just keep the corpus green through items 1-6.
9. `task` subagent lifecycle rendering (needs probe + possibly
   `packages/opencode-headless` part-progress emission): live "subagent running"
   affordance during fan-out, `TaskSubagentRow` on commit. This is the only item with
   potential upstream opencode-headless scope.
10. `question` tool → AskUserQuestion-style row (probe first).

### Explicitly NOT doing
- No tool-name renaming in `mapper.ts`/`EventDispatcher.ts` (breaks resume identity,
  hides evidence).
- No new test:* scripts or standalone test files outside existing suites.
