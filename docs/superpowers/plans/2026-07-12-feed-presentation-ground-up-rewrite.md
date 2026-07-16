# Feed Presentation Rewrite — Ground-Up Plan After the Clean Event Boundary

> Date: 2026-07-12
> Status: implemented on the UI Component Rewrite / PR #524 branch; retained as evidence and design rationale
> Scope: everything that turns the already-clean `FeedRenderItem[]` list into React UI
> Frozen boundary: session ingest, semantic folding, ghosts, ownership, ordering, and `FeedRenderItem[]`
> Supersedes: the painter-architecture portions of `2026-07-11-feed-render-layer-rewrite.md` where the landed implementation still keeps separate live/committed dispatch trees; it does not supersede the ownership-ledger design

## 1. The outcome

The feed should show **what the agent is doing**, not the protocol used to ask it to do that work.

When an agent starts editing a file, the user should immediately see an editing row, the path as soon as it is knowable, and red/green syntax-highlighted diff lines as they arrive. When an agent runs a command, the user should see the command, working directory, live ANSI output, elapsed time, and exit state. Reads, searches, web work, subagents, plans, questions, MCP calls, images, and the remaining tool families should each expose the information that helps a person understand progress and outcome.

The row that appears at the start of an operation must remain the same row while input streams, while the operation runs, when output arrives, and when committed transcript ownership replaces semantic ownership. Completion is a props update, not a different renderer winning later.

Raw wrapper JavaScript, escaped JSON, provider XML, and wire event names are debugging information. They must not be the normal feed.

## 2. Evidence read for this plan

This plan is based on source code, native-provider references, and recorded sessions rather than a guessed tool list.

### 2.1 Agent Code evidence

- 55 full local debug captures, approximately 570 MB, containing combinations of semantic logs, screen snapshots, runtime state, rendered HTML, feed-debug timelines, incident traces, and performance traces.
- 48 distilled rendering bundles checked into `testing/fixtures/rendering-bundles/`:
  - 26 Claude bundles
  - 19 Codex bundles
  - 3 OpenCode bundles
  - 3,149 committed entries
  - 578 semantic turns
  - 3,100 expected painted rows
- 160 local Claude transcript files whose project paths relate to Agent Code.
- 470 local Codex rollout files whose session metadata points at Agent Code or one of its worktrees.
- 52 OpenCode sessions in the local OpenCode database, containing 218 messages and 898 parts.
- The complete current React feed path, including the ownership-ledger bridge, `Feed.tsx`, both dispatch ladders, current artifact cards, tool-result pairing, collapsed activity, subagent rows, Markdown, ANSI, diff, code, Monaco, and LSP support.

The transcript scan is useful for prioritization. It found, among other things:

- Claude: 10,240 Bash calls, 2,404 Reads, 2,275 Edits, 604 Writes, 579 Agent calls, 791 task create/update calls, 108 ToolSearch calls, 99 Skill calls, 96 scheduled wakeups, and many orchestration/MCP calls.
- Codex: 41,930 `exec_command` calls, 3,237 `write_stdin` calls, 3,020 classic `apply_patch` calls, 1,611 modern unified `exec` calls, 1,000+ orchestration calls, 255 `spawn_agent` calls, 210 plan updates, and 198 web searches.
- OpenCode: 232 reads, 46 globs, 14 greps, and smaller real samples of bash, task, todo, and skill calls.

These counts are not product analytics and include old sessions and provider-version drift. They are still strong evidence for implementation order: file/terminal work first, collaboration and planning next, then lower-frequency surfaces.

### 2.2 Native provider references

The read-only `vendor/` references were inspected for presentation patterns, not copied as architecture:

- Claude Code tool UIs for Bash, Read, Edit, Write, Grep, Glob, Agent, AskUserQuestion, NotebookEdit, LSP, MCP, WebSearch, WebFetch, Skill, plan/worktree tools, task tools, scheduling, and configuration.
- Codex TUI history cells for unified exec, background-terminal interaction, patches, syntax-highlighted diffs, MCP output, web search, plans, hooks, requests for user input, images, and multi-agent activity.
- OpenCode's event and persisted-part shapes, including its explicit tool progress/status model and session diff records.

The native renderers establish a useful minimum: commands are commands, edits are edits, waits are compact, MCP output is typed, and plans/subagents have intentional summaries. Agent Code should retain that clarity while using the browser to add richer diffs, links, structured output, expansion, images, and semantic tokens.

### 2.3 The exact streaming failure

The full capture `2026-07-12T12-27-53-814-10b754c5` proves the current failure mechanism.

For one modern Codex unified `exec` edit:

- the clean semantic stream emitted `tool_input_delta` continuously;
- `const patch` was recognizable almost immediately;
- `*** Begin Patch` was present 29 ms after the input started and the first
  Add/Update/Delete file header followed inside the declared literal;
- `tools.apply_patch(...)` did not appear until about 1.43 seconds later;
- `SemanticLiveBlockRow` called `classifyUnifiedExecScript` on every prefix;
- the classifier required the late invocation before returning `apply_patch`;
- the live row therefore rendered `GenericToolCard` with wrapper JavaScript for the whole useful streaming window, then swapped to `DiffCard` near completion.

Nothing is missing in ingest. The presentation layer asks the wrong question. It asks, “Is the complete wrapper call visible yet?” It should ask, “What user intent is already proven by this prefix?”

## 3. Hard boundary: what this work must not change

The following remain frozen unless a separate, fixture-gated correctness bug is found and approved:

- `src/renderer/src/session-runtime/**`
- `src/renderer/src/rendering/**`
- provider headless channels and adapters
- transcript ingestion and mappers
- ghost creation/reconciliation
- ownership-ledger candidates and decisions
- feed ordering
- `FeedRenderItem` variants and semantics
- screen-condition ownership
- stream-phase derivation

Before and after this rewrite, the same recorded inputs must produce the same `FeedRenderItem[]`, in the same order, with the same ownership reasons.

Pure provider extractors may be improved because they interpret data already handed to presentation. They may not create another event stream, store, reducer, or visibility policy.

## 4. Product rules for the feed

### 4.1 Show intent before serialization

As soon as a prefix proves an operation family, render that family. Do not wait for valid JSON, a closing string, a final wrapper invocation, a result, or committed transcript ownership.

Examples:

- a declared `*** Begin Patch` value plus its first Add/Update/Delete file
  header is enough to show an edit row. The marker alone is ordinary string
  data and must not misclassify a later command.
- `tools.exec_command(` is enough to show a command row, even if `cmd` is not closed yet.
- a closed `file_path` key is enough to title an Edit or Write row.
- a `web_search_call` block is enough to show “Searching the web,” before a result exists.
- a spawn call is enough to show a starting subagent, before its id or final report exists.

### 4.2 Never expose transport by default

Normal feed UI must not show:

- `const patch = ...`
- `await tools.apply_patch(...)`
- escaped JSON strings
- `<command-name>` or `<task-notification>` envelopes
- response item kinds such as `custom_tool_call`
- raw MCP content envelopes

The exact source remains available in a development/debug expansion and in saved debug bundles. Hiding protocol from normal presentation must not destroy diagnosability.

### 4.3 One operation, one stable row

An operation has a user-facing lifecycle:

```text
preparing -> streaming input -> running/waiting -> complete | failed | denied | cancelled
```

It does not have a “live card” lifecycle followed by a different “committed card” lifecycle.

The stable id is derived in this priority order:

1. provider tool-use/call id;
2. stable upstream item id when it is the only correlation id;
3. committed block id;
4. source item key plus content-block index as a defensive fallback.

The same tool id must generate the same React key from semantic and committed inputs. A fallback id is honest about lacking convergence; it must never be based only on visible array position.

### 4.4 Progressive disclosure

Every operation has three information levels:

1. **Always visible:** verb, subject, current status, and the most important count/result.
2. **Inline when useful:** a small live preview such as diff lines, recent terminal output, found paths, selected answer, or active plan step.
3. **Expandable:** complete output, full parameters, full source, verbose metadata, and raw protocol for debugging.

The default view should answer “what happened?” without becoming a wall of cards.

### 4.5 Enrichment may summarize, never erase

Structured command/test/JSON/MCP summaries sit above an expandable original output. If a formatter is wrong or incomplete, the user can still inspect and copy the source output.

Every input `FeedRenderItem` receives a projection receipt:

- painted as a presentation node;
- absorbed into another node, with that target id;
- represented by an explicit fallback.

There is no silent `return null` for an unknown shape. Known no-content protocol ticks may be absorbed, but the debug receipt must explain why.

## 5. Minimal architecture

### 5.1 One new boundary

```text
clean channels / committed transcript
              |
              v
session-runtime + ownership ledger       FROZEN
              |
              v
FeedRenderItem[]                         FROZEN CONTRACT
              |
              v
projectFeedPresentation(...)             NEW, PURE, RENDER-ONLY
              |
              v
PresentationNode[]
              |
              v
Feed -> OperationRow / MessageRow / SystemRow
```

`projectFeedPresentation` receives:

- `FeedRenderItem[]`;
- provider kind;
- read-only tool-use and tool-result indices;
- read-only subagent/task-notification state;
- the tool-index version;
- display settings that actually alter presentation.

It performs no IO and owns no mutable session state. LSP token requests and image loading remain lazy UI enrichments beneath a presentation node.

### 5.2 Four pure files, not a framework

Initial structure:

```text
src/renderer/src/features/feed/presentation/
  types.ts             # PresentationNode, OperationVM, ProjectionReceipt
  projectFeed.ts       # FeedRenderItem[] -> PresentationProjection
  projectBlock.ts      # committed/live block normalization and pairing
  classifyOperation.ts # finite user-intent classification + partial extraction
```

Provider quirks stay in the existing pure extractor modules:

```text
src/providers/claude/renderer/extractors.ts
src/providers/codex/renderer/extractors.ts
src/providers/opencode/renderer/extractors.ts   # add only when a real shape needs it
```

There is deliberately no plugin API, detector DSL, rules engine, class hierarchy, provider-specific React registry, or presentation store.

### 5.3 Presentation union

The top-level union is small:

```ts
type PresentationNode =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; /* prose data */ }
  | { kind: 'operation'; id: string; operation: OperationVM }
  | { kind: 'activity'; id: string; /* low-signal grouped work */ }
  | { kind: 'system'; id: string; /* compaction, hooks, snapshots, notices */ }
  | { kind: 'fallback'; id: string; /* visible, structured unknown */ }
```

`OperationVM` has one common shell and a finite `family` union. Families describe user intent, not provider tool names:

```text
file-change       command          terminal-interaction
read              search           web
collaboration     task-plan        question
mcp               image            notebook
code-intelligence skill-workflow   workspace
generic
```

This is enough separation to make each presentation useful without making one component per tool name.

Common operation fields include:

- stable id and all source keys;
- provider and original tool name for debug/copy;
- lifecycle state;
- user-facing verb and subject;
- start/end/duration data when available;
- error/denial/cancellation data;
- parsed detail for the family;
- original input and output for debug expansion;
- confidence/evidence used by prefix classification.

### 5.4 One React operation shell

```text
src/renderer/src/features/feed/ui/operations/
  OperationRow.tsx
  FileOperation.tsx
  CommandOperation.tsx
  LookupOperation.tsx
  CollaborationOperation.tsx
  StructuredOperation.tsx
  GenericOperation.tsx
```

`OperationRow` is always the mounted outer component for an operation. Its family body may appear as evidence improves, but the outer `data-operation-id` DOM node and React key remain stable.

The current artifact cards are implementation material, not a second system. Good pieces move into the operation files; obsolete wrappers are deleted during the same family cutover.

## 6. Streaming classification

### 6.1 Evidence is monotonic

Classification returns:

```ts
type OperationClassification = {
  family: OperationFamily | 'preparing'
  confidence: 'hint' | 'structural' | 'final'
  evidence: string
  partial: FamilyPartialPayload
}
```

The evidence ladder is designed so later prefixes refine detail without changing a proven family. If input is genuinely ambiguous, show a compact “Preparing operation…” row. Never dump the undecoded wrapper as the fallback for ambiguity.

### 6.2 Unified Codex `exec`

Do not add a JavaScript parser. Codex emits a narrow generated wrapper grammar, and the useful payloads are string literals plus known `tools.*` calls. Implement a single-pass, partial-safe scanner that recognizes:

- variable declarations whose decoded string begins with `*** Begin Patch`;
- direct or variable-backed `tools.apply_patch` calls;
- `tools.exec_command` object literals;
- `tools.write_stdin` object literals;
- `wait(...)`/poll wrappers used by the host;
- the final `text(...)`, `image(...)`, `generatedImage(...)`, and notification wrappers as non-user-facing plumbing.

The scanner tracks quotes, escapes, template literals, comments, and balanced delimiters only to the degree needed to avoid false matches. It does not execute code and does not build an AST.

For a patch wrapper, the first decoded `*** Begin Patch` prefix fixes the family to `file-change`; the parser then streams complete patch lines and keeps an unfinished tail. The late `tools.apply_patch` call only confirms what is already known.

### 6.3 Partial JSON tools

Reuse and generalize the existing partial-string scanners used by Write/Edit:

- closed scalar keys become visible immediately;
- a growing content string is JSON-unescaped incrementally;
- arrays expose completed elements plus one partial tail where useful;
- parse failure affects the debug expansion, not the existence of the row.

This is a small utility for provider-generated JSON, not a permissive JSON5 parser.

## 7. Operation-family presentation

### 7.1 File changes and writes

Covered inputs:

- Claude `Edit`, `MultiEdit`, and `Write`;
- Codex `apply_patch` and unified `exec` patch wrappers;
- OpenCode patch parts and edit/write tool calls when observed;
- shell edits only when a conservative parser proves an edit operation, such as a known in-place `sed` form;
- notebook edits through the notebook family, reusing diff primitives.

Default presentation:

- verb: Creating, Editing, Moving, or Deleting;
- normalized workspace-relative path;
- file count for multi-file patches;
- green added and red removed totals;
- a streaming diff body with stable line identity;
- status and error directly on the same row;
- full patch/source in debug expansion.

Write is treated as a file change:

- a new file is all green additions;
- a known overwrite renders before/after differences;
- when no before snapshot exists, show a clearly labeled “new content” addition view rather than pretending a semantic diff exists.

No raw wrapper JavaScript or JSON is shown while waiting for the path. The row begins as “Editing file…” and fills in the path and diff as soon as each becomes knowable.

### 7.2 Token-by-token code rendering

Diff background and code tokens are separate layers:

- row background communicates added/removed/context;
- token spans communicate language semantics;
- line numbers/gutters remain stable while spans upgrade.

Rendering order:

1. show plain text immediately;
2. apply cached lexical highlighting to sealed lines;
3. replace token spans in place with LSP semantic tokens when available.

Use the existing LSP bridge; do not mount and recreate a Monaco editor for every streaming delta.

For JavaScript/TypeScript variants, a lightweight hook opens one stable virtual document per operation side, sends `changeLspDocument` at most once per animation frame after content changes, requests semantic tokens, decodes them using the existing legend, and closes the document on unmount. A generation counter discards stale responses.

Removed lines are tokenized against the available “before” text; added/context lines against the available “after” text. If a hunk lacks enough surrounding source for meaningful semantic tokens, lexical highlighting remains the honest fallback. The presentation projector must not read files from disk to manufacture context.

Other languages use the existing language normalization plus highlight.js/Monaco lexical tokenization. Adding more language servers is a separate product decision, not part of this renderer rewrite.

### 7.3 Commands and terminal interaction

Covered inputs:

- Claude Bash/PowerShell;
- Codex `exec_command`, `local_shell_call`, classic tool calls, and unified `exec` wrappers;
- OpenCode bash;
- `write_stdin`, wait/poll, and background-terminal continuation calls.

Always visible:

- Running/Ran/Failed;
- actual command, syntax-highlighted as shell;
- cwd when it differs from the workspace root;
- description when supplied;
- running duration, final duration, exit code, timeout, and background session id when known.

Inline output:

- live ANSI rendering;
- recent output while running;
- clear truncation counts;
- failure lines retained rather than tinted as one undifferentiated slab.

Terminal interaction is folded into the originating command when a reliable session/call id links them. Otherwise it gets a compact “Sent input to background terminal” or “Waited for background terminal” row. Empty polling ticks are absorbed with a debug receipt.

Conservative output enrichment appears above expandable raw output:

- JSON objects/arrays as structured key/value or table views;
- `path:line:column` diagnostics as clickable file links;
- common test summaries as passed/failed/skipped counts when the output contains a complete, unambiguous summary;
- URLs as links;
- existing git intent cards for recognized git commands.

There is no general command-parser plugin system. Add a formatter only when it has a stable grammar, a fixture, and a raw-output fallback.

### 7.4 Reads, searches, and discovery

Covered inputs:

- Read/FileRead/OpenCode read;
- Grep/Glob/LS and OpenCode grep/glob;
- Codex commands whose committed metadata classifies them as reads/searches;
- ToolSearch/tool-search calls;
- transcript search/read tools.

Presentation distinguishes:

- reading a file;
- listing paths;
- searching text;
- searching available tools;
- inspecting another transcript.

The header shows target, pattern, include filter, range/offset, and result count. Results use file links, match highlighting, and expandable code/text. Repeated low-signal reads/searches may remain grouped into the existing activity receipt, but the currently active lookup and any failed lookup stay individually visible.

### 7.5 Web, citations, and fetched content

Covered inputs:

- Claude WebSearch/WebFetch;
- Codex web search/open/find actions;
- citations attached to assistant blocks.

The row shows the actual query/action, target URL, progress tense, result count when available, and linked sources. Assistant citations render as a compact source list, not only a citation count. Fetched content stays collapsed by default with title/domain metadata above it.

### 7.6 Collaboration and subagents

Covered inputs:

- Claude Agent/Task;
- Codex/OpenAI spawn/send/follow-up/wait/list/close operations;
- Agent Code orchestration MCP calls;
- task notifications and tracked `SubAgentState`;
- OpenCode task calls.

One collaboration presentation handles:

- spawn: role, nickname, prompt summary, model, status;
- message: target and concise sent text;
- wait: target set, current states, elapsed time;
- list: structured agent table;
- read output: linked child and recent/final response;
- close/interrupt: target and outcome.

The existing `TaskSubagentRow` drill-in and mini-feed behavior should be reused. Raw spawn join payloads do not render separately. Final reports must never be suppressed merely because the spawn card exists.

### 7.7 Tasks, todos, plans, schedules, and workflow

Covered inputs:

- TodoWrite/todowrite;
- TaskCreate, TaskUpdate, TaskList, TaskGet, TaskOutput, TaskStop;
- Codex `update_plan`;
- plan-mode enter/exit records;
- ScheduleWakeup/Sleep/cron shapes;
- Skill and Workflow calls.

Presentation uses checklist/status language rather than JSON:

- plan steps have pending/in-progress/completed states;
- task mutations say what changed;
- schedules show when and why;
- skill/workflow calls show the selected skill/workflow, arguments, run/resume state, and final result.

### 7.8 Questions and blocking interaction

AskUserQuestion/request-user-input rows show question text, options, multi-select state, free-text affordances, and the durable answer after completion.

Interactivity is enabled only while the authoritative condition state says that exact request owns input. A committed/history row is a record, not a live control. This preserves the modal/input ownership work and prevents a stale feed row from sending keys into the agent.

### 7.9 MCP and typed rich output

Generic MCP is one structured family, not one React component per server.

Header:

- Calling/Called/Failed;
- humanized tool name;
- server badge;
- concise headline chosen from path, URL, query, title, description, or target fields.

Input:

- small scalar objects as key/value rows;
- paths and URLs linkified;
- large/nested values behind expansion;
- raw JSON available for copy/debug.

Output content is dispatched by content type:

- text and ANSI text;
- JSON/table-like data;
- image/data URL;
- audio attachment metadata;
- embedded resource;
- resource link;
- explicit empty result;
- error.

Known Agent Code orchestration and workspace tools route to collaboration/workspace families before generic MCP. Other server-specific cards are added only when repeated evidence shows that typed MCP rendering is insufficient.

### 7.10 Images, notebook, LSP, workspace, and system records

- Base64 and URL images render inline with alt/source metadata and a safe open action.
- Image generation shows live status, revised prompt, generated preview when present, and saved path.
- View-image shows the path and actual image when available.
- NotebookEdit shows notebook path, cell id/type/mode, and a syntax-highlighted cell diff.
- LSP tool calls show operation, symbol/file/range, result count, and linked locations.
- Workspace/worktree/config operations show the specific state transition rather than generic JSON.
- Compaction, hooks, file snapshots, provider notices, and errors use intentional system rows.
- Unknown committed block kinds render a visible fallback containing a safe summary; they never become an empty text branch.

## 8. Migration phases

Each phase is a vertical slice. It introduces the new projection for a family, routes both semantic and committed shapes through it, verifies replay/DOM stability, and deletes that family's branches from the old ladders in the same PR. Do not build the entire new tree beside the old tree and defer cutover.

### Phase 0 — replay evidence and boundary lock

Goal: make presentation regressions reproducible without changing ingest.

Work:

- teach `scripts/extract-rendering-fixtures.mjs` and `scripts/audit-rendering-fixture.mjs` the newest bundle layout (`proxy-semantic.json`, feed-debug semantic deltas, trace tails);
- extract a small redacted prefix replay from the 2026-07-12 unified-exec patch capture;
- record only event kind, call identity, prefix text with paths/content redacted, and expected presentation snapshots;
- assert that current ownership/replay output remains unchanged;
- document transcript-corpus counts and fixture privacy rules in `testing/fixtures/README.md`.

No production renderer changes in this phase.

### Phase 1 — presentation projection and exact patch fix

Goal: establish the new seam using one high-value vertical slice.

Work:

- add the four pure presentation files;
- add `OperationRow` and file-operation body;
- implement the partial unified-exec scanner;
- flatten entry and semantic sources into stable presentation ids;
- pair/absorb tool results with projection receipts;
- route modern/classic Codex patches and Claude Edit/Write through the new row;
- use the existing DiffView/StreamingCodeBlock pieces initially;
- remove those branches from `Block.tsx`, `BlockRow.tsx`, and the old resolve modules.

Exit criteria:

- the exact captured prefix becomes an edit row by the first patch header;
- wrapper JavaScript never appears in normal UI;
- the same outer DOM node survives every prefix, tool completion, and live-to-committed handoff;
- successful and failed patches both remain visible.

### Phase 2 — streaming diff and semantic token layer

Goal: make file work the best-rendered surface in the app.

Work:

- add stable diff-line ids and unfinished-tail handling;
- make Write/new-file content use green addition presentation;
- add lightweight sealed-line lexical highlighting;
- add incremental LSP token enrichment for supported JS/TS variants using one stable virtual document;
- add copy/open-file behavior and responsive/mobile layout;
- keep lexical fallback for unsupported or incomplete snippets;
- remove the current live raw-input fallback and per-delta Monaco recreation path.

### Phase 3 — commands and terminal sessions

Goal: one command lifecycle from invocation through output and exit.

Work:

- migrate Bash, exec_command, local shell, OpenCode bash, unified exec command, write_stdin, and wait;
- fold reliably correlated stdin/wait calls;
- preserve ANSI and truncation metadata;
- add structured JSON, diagnostic-link, test-summary, URL, and git enrichments with raw fallback;
- delete old command/result renderers and standalone output duplication.

### Phase 4 — reads, searches, web, and citations

Goal: turn high-volume lookup churn into readable progress and useful results.

Work:

- migrate Read/Grep/Glob/LS/OpenCode read and command-classified reads;
- migrate ToolSearch/transcript search;
- migrate WebSearch/WebFetch/Codex web actions;
- render citation sources;
- retain evidence-backed collapsed activity for completed low-signal runs;
- delete old special cases from `ToolResultRow` and semantic dispatch.

### Phase 5 — collaboration, tasks, questions, and MCP

Goal: make agent orchestration and interactive work understandable without JSON archaeology.

Work:

- migrate all spawn/send/wait/list/read/close variants;
- reuse and simplify TaskSubagentRow/mini-feed;
- join task notifications and final reports without hiding either;
- migrate Todo/Task/Plan/Schedule/Skill/Workflow;
- migrate AskUserQuestion durable/live states;
- add typed MCP content rendering;
- route Agent Code orchestration/workspace MCP calls to richer families.

### Phase 6 — prose, long tail, and deletion

Goal: finish convergence and remove the split renderer.

Work:

- move user/assistant prose, reasoning, citations, images, system, and compaction into presentation nodes;
- add notebook/LSP/workspace/config/image-generation specializations;
- make generic fallback total and debug-friendly;
- delete the two old dispatch ladders, JSX provider dispatch capabilities,
  duplicate result rows, and the obsolete family-routing registry;
- update rendering docs to point to the new projection.

## 9. Files affected

### New production files

- `src/renderer/src/features/feed/presentation/types.ts`
- `src/renderer/src/features/feed/presentation/projectFeed.ts`
- `src/renderer/src/features/feed/presentation/projectBlock.ts`
- `src/renderer/src/features/feed/presentation/classifyOperation.ts`
- `src/renderer/src/features/feed/ui/operations/OperationRow.tsx`
- `src/renderer/src/features/feed/ui/operations/PresentationRow.tsx`
- `src/renderer/src/features/feed/ui/operations/StructuredOperationCard.tsx`
- `src/renderer/src/features/feed/ui/operations/CommandOutput.tsx`
- `src/renderer/src/features/feed/ui/operations/CommandOutputAnalysis.ts`
- `src/renderer/src/features/feed/ui/kit/StructuredOutput.tsx`
- `src/renderer/src/features/feed/ui/kit/SemanticTokenText.tsx`

These files are added only as their phase needs them. Empty scaffolding files are not created in advance.

### Existing production files modified early

- `src/renderer/src/features/feed/ui/Feed.tsx`
  - project `FeedRenderItem[]` once and render presentation nodes;
  - key operation rows by presentation id;
  - emit projection receipts in RENDER debug output.
- `src/renderer/src/features/feed/ui/kit/DiffView.tsx`
  - stable line identity, streamed tail, semantic token spans.
- `src/renderer/src/features/feed/ui/kit/StreamingCodeBlock.tsx`
  - share sealed-line/token primitives with file operations.
- `src/renderer/src/lib/code/CodeBlock.tsx`
  - stop treating a growing `code` prop as a reason to destroy/recreate Monaco/LSP resources;
  - use `changeLspDocument` when an incremental editor-backed view is actually requested.
- `src/providers/codex/renderer/extractors.ts`
  - replace late invocation-only unified-exec classification with partial intent extraction.
- `src/providers/claude/renderer/extractors.ts`
  - centralize remaining partial input and structured result extraction.
- `src/providers/opencode/renderer/transcript/mapper.ts` and a new pure extractor only if real OpenCode shapes cannot be normalized in `projectBlock.ts` without provider leakage.

### Existing files removed or reduced as families migrate

- `src/renderer/src/features/feed/ui/semantic/BlockRow.tsx`
- `src/renderer/src/features/feed/ui/rows/Block.tsx`
- `src/renderer/src/features/feed/ui/rows/ConversationRow.tsx`
- `src/renderer/src/features/feed/ui/rows/ToolResultRow.tsx`
- `src/renderer/src/features/feed/ui/resolve/registry.ts`
- superseded files under `src/renderer/src/features/feed/ui/artifacts/`
- `src/providers/*/renderer/rows/dispatch.tsx`
- JSX row-capability fields in `src/providers/registry.renderer.capabilities.ts`
- remaining duplicate generic/JSON/result slabs after StructuredOutput owns them.

Good current components such as the subagent mini-feed, AskUserQuestion controls, ANSI parser, expansion behavior, Markdown components, and portions of the artifact cards are moved/reused rather than rewritten for novelty.

`resolve/fromLive.ts` and `resolve/fromCommitted.ts` remain as small pure
adapters for the already-useful artifact view models. They no longer classify
families or dispatch React; `classifyOperation` and `OperationRow` own those two
decisions. Deleting and retyping the adapters would add churn without reducing
architecture, while restoring a registry beside them would violate this plan.

### Test and evidence files

- `scripts/extract-rendering-fixtures.mjs`
- `scripts/audit-rendering-fixture.mjs`
- `testing/fixtures/README.md`
- one redacted presentation-prefix fixture under the existing rendering-recording corpus
- existing rendering corpus/replay suites
- existing Codex rollout/extractor tests
- existing semantic render-unit tests, reduced as presentation grouping moves
- existing renderer DOM tests for question/input ownership and operation stability.

## 10. Verification

### 10.1 Boundary invariants

- Run the full ownership-ledger bundle corpus before and after every phase.
- Compare serialized `FeedRenderItem[]`; any difference blocks the presentation PR.
- No presentation module may be imported by `session-runtime/**` or `rendering/**`.
- No new store/reducer/event type is introduced for presentation.

### 10.2 Prefix replay

For every streaming tool fixture, replay every prefix, not only the final input.

Assertions for the captured patch case:

- before intent evidence: compact Preparing row, no raw script;
- at `*** Begin Patch`: family is file-change;
- every completed patch line appears monotonically;
- unfinished line updates in place;
- family never reverts;
- outer operation element remains `isSameNode` across rerenders;
- final committed input produces the same family, id, title, path, diff, and result.

Equivalent prefix tests cover Write, Edit, exec_command, write_stdin, MCP JSON, and AskUserQuestion.

### 10.3 Total projection

For all corpus inputs:

- every source key has exactly one projection receipt;
- every absorbed result names its owning operation;
- every unknown block/tool produces a visible fallback;
- no normal rendered text contains `tools.apply_patch`, `tools.exec_command`, `<command-name>`, or escaped provider wrappers unless the user opened Debug source.

### 10.4 Visual behavior

Verify each migrated family in:

- wide desktop;
- narrow tiled pane;
- remote/mobile feed;
- light, dark, and high-contrast modes;
- reduced motion;
- keyboard-only navigation;
- large output/diff truncation and expansion.

### 10.5 Performance and lifecycle

- No Monaco/editor/model recreation per stream delta.
- No whole-message Markdown parse per text delta.
- Prefix classification is linear in the current prefix and bounded for debug source retention.
- Sealed diff/code lines retain their DOM nodes.
- LSP changes are batched to one per animation frame and stale responses are discarded.
- A long saved-session bootstrap remains lazy for old committed rows.
- The projection initially uses `useMemo` and existing stable entry objects; add only a `WeakMap` committed-entry cache if profiling proves projection cost material. Do not prebuild a cache subsystem.

## 11. Explicit anti-overengineering rules

Do not add:

- a second event pipeline;
- a presentation Zustand store;
- a reducer or state machine library;
- a generic plugin/renderer SDK;
- provider-specific JSX trees;
- one component per tool name;
- a JavaScript AST/parser just for generated unified-exec wrappers;
- file reads from the presentation projector;
- new language servers as part of diff rendering;
- speculative cards for tools absent from source or recordings;
- fuzzy grouping of unrelated operations;
- long-lived dual rendering behind a permanent feature flag.

Use these tests before introducing an abstraction:

1. Does it prevent a recorded bug class?
2. Is it reused by at least two real operation families now?
3. Can it be explained without referring to a future plugin/provider?
4. Does deleting it make the implementation less correct, not merely less architectural?

If the answer is no, keep the code local and explicit.

## 12. Definition of done

The rewrite is complete when:

- `FeedRenderItem[]` remains the unchanged clean boundary;
- Feed renders one `PresentationNode[]` path, not live and committed ladders;
- every operation uses a stable identity across stream, result, and commit;
- file changes and writes stream useful red/green code immediately;
- supported code receives in-place LSP semantic token enrichment with lexical fallback;
- commands stream ANSI output and show cwd, duration, exit, errors, and terminal interaction;
- read/search/web/collaboration/task/question/MCP/image/notebook/LSP/workspace families have intentional presentation;
- unknowns are structured fallbacks, not raw dumps or blank rows;
- projection receipts account for every source item;
- the old dispatch/resolver duplicates are deleted;
- corpus, prefix, DOM-stability, mobile, accessibility, and performance checks pass.

The practical first implementation PR is Phase 0 plus the smallest Phase 1 slice needed to make the captured unified-exec patch render as an edit from the first patch header. That gives the architecture a real burden immediately and prevents another round of scaffolding that does not improve the feed.
