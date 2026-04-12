# Codex Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenAI Codex as a second agent provider alongside Claude Code, with clean separation of concerns so provider-specific logic never mixes.

**Architecture:** Three-phase approach: (1) refactor shared infrastructure so provider-specific code has a clear home, (2) refactor the testbench to be provider-agnostic, (3) build the Codex integration on top of the clean foundation. Each provider owns its own parsers, transcript types, session class, session-list, and feed row renderers. Shared infrastructure (PtyScreen, jsonlTailer, tile tree, workspace store, Feed scroll/memo framework) stays provider-agnostic.

**Tech Stack:** TypeScript, Electron, React, node-pty, @xterm/headless, @xterm/xterm

---

## File Structure

### Files to create

```
src/core/types/codexTranscript.ts          — Codex JSONL entry shapes (RolloutLine, RolloutItem, etc.)
src/core/runtime/codexSession.ts           — CodexSession class (composes PtyScreen + codex-specific wiring)
src/core/runtime/codexProjectDir.ts        — ~/.codex/sessions/YYYY/MM/DD/ path resolution
src/core/runtime/codexSessionList.ts       — List codex sessions for the resume picker
src/core/parsers/codex/streamingScreen.ts  — Chrome stripper for codex's TUI (▌ gutter, etc.)
src/renderer/src/feed/codex/              — (directory) Codex-specific feed row renderers
src/renderer/src/feed/codex/CodexRows.tsx  — Row components for codex transcript entries
testbench/codex-record.ts                  — Record a codex session (parallel to record.ts)
testbench/codex-replay.ts                  — Replay codex recordings through codex parsers
```

### Files to modify

```
src/core/types/transcript.ts               — Rename to claudeTranscript.ts, keep re-exports for compat
src/renderer/src/tiles/types.ts            — SessionKind gains 'codex', SessionMeta gains providerSessionId
src/main/sessionManager.ts                 — Add CodexSession to the union, spawn dispatch
src/main/index.ts                          — session:spawn accepts kind='codex'
src/preload/index.ts                       — No change needed (kind already flows through)
src/renderer/src/tiles/workspaceStore.ts   — Codex jsonl-entry handling, codex session ID capture
src/renderer/src/tiles/TileTree.tsx        — Dispatch kind='codex' to TileLeaf (same component, different feed)
src/renderer/src/feed/Feed.tsx             — Provider-aware row rendering dispatch
src/renderer/src/tiles/useKeybinds.ts      — Add alt-c / alt-shift-c for codex splits
src/renderer/src/tiles/PathPickerModal.tsx  — Provider dropdown in the new-tab modal
testbench/record.ts                        — Rename to claude-record.ts or parameterize with provider flag
testbench/replay.ts                        — Rename to claude-replay.ts or parameterize
package.json                               — Add record:codex and replay:codex scripts
```

---

## Phase 1: Refactoring for Clean Separation

### Task 1: Rename transcript types to be provider-scoped

**Files:**
- Rename: `src/core/types/transcript.ts` → `src/core/types/claudeTranscript.ts`
- Create: `src/core/types/transcript.ts` (re-export hub)

- [ ] **Step 1: Rename the file**

```bash
git mv src/core/types/transcript.ts src/core/types/claudeTranscript.ts
```

- [ ] **Step 2: Create a re-export hub so existing imports don't break**

Create `src/core/types/transcript.ts`:
```ts
// Re-export hub — existing callers import from here unchanged.
// Each provider's transcript types live in their own file;
// this file re-exports the union so provider-agnostic code
// (Feed framework, workspaceStore) can import a single Entry type.
export * from './claudeTranscript.js'
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.node.json --noEmit
```
Expected: clean (all imports still resolve via the re-export hub)

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "types: rename transcript.ts to claudeTranscript.ts + re-export hub"
```

---

### Task 2: Widen SessionKind to include 'codex'

**Files:**
- Modify: `src/renderer/src/tiles/types.ts`

- [ ] **Step 1: Update the SessionKind type**

In `types.ts`, change:
```ts
export type SessionKind = 'claude' | 'terminal'
```
to:
```ts
export type SessionKind = 'claude' | 'codex' | 'terminal'
```

Update the JSDoc to mention codex.

- [ ] **Step 2: Rename ccSessionId → providerSessionId in SessionMeta**

In `types.ts`, change:
```ts
ccSessionId?: string
```
to:
```ts
providerSessionId?: string
```

Update the JSDoc. This field is now used by both Claude (CC session UUID) and Codex (thread UUID).

- [ ] **Step 3: Find and update every reference to ccSessionId**

```bash
grep -rn 'ccSessionId' src/
```

Update each occurrence in `workspaceStore.ts` (capture handler, rehydrate, save) to use `providerSessionId`.

- [ ] **Step 4: Typecheck both configs**

```bash
npx tsc -p tsconfig.web.json --noEmit && npx tsc -p tsconfig.node.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "types: widen SessionKind to include codex, rename ccSessionId → providerSessionId"
```

---

### Task 3: Extract Feed row rendering into provider-scoped modules

**Files:**
- Create: `src/renderer/src/feed/claude/ClaudeRows.tsx`
- Modify: `src/renderer/src/feed/Feed.tsx`

- [ ] **Step 1: Create ClaudeRows.tsx**

Extract from Feed.tsx into a new file `src/renderer/src/feed/claude/ClaudeRows.tsx`:
- `EditRow`, `MultiEditRow`, `WriteRow`, `TodoRow` (all the Claude tool-specific row renderers)
- `FileToolHeader`, `DiffSlab`, `editInput`, `basenameOf` (helpers used by those rows)
- `parseTodos`, `TodoItem`, `TodoItemRow` (todo helpers)

Each component stays `memo`'d with the same props. Export them all as named exports.

Keep in Feed.tsx:
- `MarkerRow` (shared layout primitive)
- `TextProse`, `StreamingProse` (shared markdown renderers)
- `ToolUseRow`, `ToolResultRow` (these dispatch by tool name and will become provider-aware)
- `ConversationRow`, `Block`, `EntryRow`, `SystemRow`, `StreamingRow`
- `UserBand`
- All the scroll/memo/context framework

- [ ] **Step 2: Import ClaudeRows in Feed.tsx**

In Feed.tsx's `Block` component, import the Claude-specific rows:
```ts
import { EditRow, MultiEditRow, WriteRow, TodoRow } from './claude/ClaudeRows'
```

The switch statement in `Block` stays in Feed.tsx — it dispatches by tool name and renders the right provider's component.

- [ ] **Step 3: Typecheck**

```bash
npx tsc -p tsconfig.web.json --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feed: extract Claude tool rows into feed/claude/ClaudeRows.tsx"
```

---

## Phase 2: Testbench Refactoring

### Task 4: Parameterize testbench by provider

**Files:**
- Modify: `testbench/record.ts`
- Modify: `testbench/replay.ts`
- Modify: `package.json`

- [ ] **Step 1: Add CC_SHELL_PROVIDER env var to record.ts**

At the top of `record.ts`, add provider detection:
```ts
const provider = (process.env.CC_SHELL_PROVIDER ?? 'claude') as 'claude' | 'codex'
```

When `provider === 'claude'`, use `ClaudeSession` (existing behavior).
When `provider === 'codex'`, use `CodexSession` (imported from `../src/core/runtime/codexSession.js` — will be created in Phase 3, but the import + switch can land now with a TODO comment).

For now, the codex branch can throw: `throw new Error('CodexSession not yet implemented')`.

- [ ] **Step 2: Add CC_SHELL_PROVIDER to replay.ts**

Same pattern. When `provider === 'codex'`, import and run codex parsers instead of claude parsers. For now, throw on codex.

- [ ] **Step 3: Add npm scripts**

In `package.json`, add:
```json
"record:claude": "CC_SHELL_PROVIDER=claude tsx testbench/record.ts",
"record:codex": "CC_SHELL_PROVIDER=codex tsx testbench/record.ts",
"replay:claude": "CC_SHELL_PROVIDER=claude tsx testbench/replay.ts",
"replay:codex": "CC_SHELL_PROVIDER=codex tsx testbench/replay.ts"
```

Keep the existing `record` and `replay` scripts as-is (default to claude).

- [ ] **Step 4: Typecheck**

```bash
npx tsc -p tsconfig.node.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "testbench: parameterize record/replay by provider (CC_SHELL_PROVIDER env)"
```

---

## Phase 3: Codex Implementation

### Task 5: Codex project dir + session list

**Files:**
- Create: `src/core/runtime/codexProjectDir.ts`
- Create: `src/core/runtime/codexSessionList.ts`

- [ ] **Step 1: Create codexProjectDir.ts**

```ts
import { homedir } from 'os'
import { join } from 'path'

// Codex stores sessions under ~/.codex/sessions/YYYY/MM/DD/
// Unlike Claude's per-cwd sanitized directory, codex uses a flat
// date-bucketed tree for all sessions regardless of cwd.

export function getCodexHome(): string {
  return (process.env.CODEX_HOME ?? join(homedir(), '.codex')).normalize('NFC')
}

export function getCodexSessionsDir(): string {
  return join(getCodexHome(), 'sessions')
}
```

- [ ] **Step 2: Create codexSessionList.ts**

Walk `~/.codex/sessions/` recursively looking for `rollout-*.jsonl` files. For each file:
- Parse the filename to extract timestamp + UUID: `rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`
- Read HEAD bytes (16 KB) to extract the `session_meta` entry's `id`, `cwd`, `timestamp`
- Read TAIL bytes for a preview of the last user message
- Return `SessionInfo[]` sorted by mtime desc (same shape as Claude's `sessionList.ts`)

The `SessionInfo` type is already defined in `src/preload/index.ts` and reused by `PathPickerModal.tsx`.

- [ ] **Step 3: Typecheck**

```bash
npx tsc -p tsconfig.node.json --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "core: codex project dir + session list (walks ~/.codex/sessions/)"
```

---

### Task 6: Codex transcript types

**Files:**
- Create: `src/core/types/codexTranscript.ts`
- Modify: `src/core/types/transcript.ts` (add re-exports)

- [ ] **Step 1: Define codex entry types**

Based on the recon (`codex-rs/protocol/src/protocol.rs:2746-2753`):

```ts
// Codex JSONL "rollout" entry types.
// Each line in a rollout file is: { timestamp, type, payload }
// where type discriminates via RolloutItem.

export type CodexRolloutLine = {
  timestamp: string
  type: string
  payload: unknown
}

export type CodexSessionMeta = {
  id: string           // UUID
  timestamp: string
  cwd: string
  originator: string
  cli_version: string
  source: string
  model_provider?: string
}

export type CodexResponseItem = {
  type: string         // "message", "function_call", "function_call_output", etc.
  role?: string        // "user" | "assistant"
  content?: Array<{ type: string; text?: string }>
  id?: string
}

export type CodexEventMsg = {
  type: string         // "user_message", etc.
  message?: string
  kind?: string
}

export function isCodexConversationEntry(line: CodexRolloutLine): boolean {
  return line.type === 'response_item' || line.type === 'event_msg'
}
```

- [ ] **Step 2: Add re-exports to the hub**

In `src/core/types/transcript.ts`, add:
```ts
export * from './codexTranscript.js'
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc -p tsconfig.web.json --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "types: codex transcript shapes (RolloutLine, ResponseItem, EventMsg)"
```

---

### Task 7: Codex streaming screen parser

**Files:**
- Create: `src/core/parsers/codex/streamingScreen.ts`

- [ ] **Step 1: Create the parser**

Start with a minimal chrome stripper that:
- Strips the `▌ ` (U+258C + space) gutter prefix from lines that have it
- Strips the bottom status row (look for codex-specific status markers — will refine after first recording)
- Strips empty trailing lines
- Returns the chrome-stripped text

Export: `extractCodexStreamingText(screen: string): string` and `extractCodexAssistantInProgress(screen: string): string`

The implementation will be MUCH simpler than Claude's initially — we refine it once we have real codex recordings. Start with:

```ts
export function extractCodexStreamingText(screen: string): string {
  if (!screen) return ''
  const lines = screen.split('\n')
  // Strip trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}

export function extractCodexAssistantInProgress(screen: string): string {
  // Placeholder — will be refined against real recordings
  return extractCodexStreamingText(screen)
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc -p tsconfig.node.json --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "parsers: stub codex streaming screen parser"
```

---

### Task 8: CodexSession class

**Files:**
- Create: `src/core/runtime/codexSession.ts`

- [ ] **Step 1: Create CodexSession**

Composes PtyScreen (like ClaudeSession does). Key differences:
- Binary: `'codex'`
- Resume args: `['resume', sessionId]` (subcommand, not flag)
- No CLAUDE_CODE_ENTRYPOINT env var
- JSONL tailer: walks `~/.codex/sessions/` instead of `~/.claude/projects/`
- Screen event: no slash-picker enrichment initially (add later)

The class should:
- Emit the same event shape as ClaudeSession (`started`, `pty-data`, `screen`, `jsonl-entry`, `jsonl-error`, `exit`) so SessionManager can treat them uniformly
- Use the same PtyScreen for PTY + headless xterm + dual snapshots
- Tail the codex rollout JSONL file using the existing jsonlTailer

For finding the rollout file: codex creates the file at startup. Use `tailNewSessionFile` pointed at the codex sessions dir, with a glob pattern for `rollout-*.jsonl`. OR watch the date-bucketed subdir.

The simplest approach for v1: don't tail a transcript at all initially. Just use the screen scrape. Add JSONL tailing as a follow-up once we have a working live codex pane.

- [ ] **Step 2: Typecheck**

```bash
npx tsc -p tsconfig.node.json --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "core: CodexSession class (composes PtyScreen, spawns codex binary)"
```

---

### Task 9: Wire CodexSession into SessionManager

**Files:**
- Modify: `src/main/sessionManager.ts`

- [ ] **Step 1: Import CodexSession and add to the union**

Add `import { CodexSession } from '../core/runtime/codexSession.js'`

Update `RegistryEntry`:
```ts
type RegistryEntry =
  | { kind: 'claude'; session: ClaudeSession }
  | { kind: 'codex'; session: CodexSession }
  | { kind: 'terminal'; session: TerminalSession }
```

- [ ] **Step 2: Add the codex spawn branch**

In `spawn()`, after the terminal branch, add:
```ts
if (kind === 'codex') {
  const session = new CodexSession({
    cwd: options.cwd,
    cols: options.cols ?? 120,
    rows: options.rows ?? 40,
    resumeSessionId: options.resumeSessionId,
  })
  // Wire events same as Claude...
  // (screen, pty-data, jsonl-entry, jsonl-error, exit)
}
```

Wire the same events as Claude (they share the same event shape by design).

- [ ] **Step 3: Typecheck**

```bash
npx tsc -p tsconfig.node.json --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "sessionManager: add CodexSession to spawn dispatch"
```

---

### Task 10: Wire codex into the renderer (TileTree dispatch + keybinds)

**Files:**
- Modify: `src/renderer/src/tiles/TileTree.tsx`
- Modify: `src/renderer/src/tiles/useKeybinds.ts`
- Modify: `src/renderer/src/tiles/workspaceStore.ts`

- [ ] **Step 1: TileTree: dispatch codex to TileLeaf**

In `TileTree.tsx`, update the kind dispatch:
```ts
if (kind === 'terminal') {
  return <TerminalLeaf ... />
}
// Both claude and codex use TileLeaf (same feed + composer UI,
// different row renderers selected by provider context inside Feed)
const runtime = workspace.getRuntime(node.sessionId)
return <TileLeaf ... />
```

Codex panes render in TileLeaf — same feed + composer — but Feed will dispatch to codex-specific row renderers based on the session's provider. This reuses all the shared infrastructure (scroll, memo, streaming card, composer, type-to-focus, history cycling).

- [ ] **Step 2: Add keybinds for codex splits**

In `useKeybinds.ts`, add after the terminal keybinds:
```ts
// alt-c: split with codex below (horizontal)
// alt-shift-c: split with codex to the right (vertical)
if (code === 'KeyC' && !shift) {
  e.preventDefault()
  void workspace.splitFocused('horizontal', 'codex')
  return
}
if (code === 'KeyC' && shift) {
  e.preventDefault()
  void workspace.splitFocused('vertical', 'codex')
  return
}
```

- [ ] **Step 3: workspaceStore: handle codex in rehydrate**

In `rehydrate()`, the existing code already handles `kind` dispatch:
```ts
const kind: SessionKind = meta.kind ?? 'claude'
```
This naturally routes codex sessions through the same spawn path. Just need to make sure the resume path uses the codex subcommand format — but that's handled inside CodexSession's constructor, not in workspaceStore.

Verify the `providerSessionId` capture works for codex too — codex entries have `sessionId` in their payload, but nested differently. May need a codex-specific capture path.

- [ ] **Step 4: Typecheck**

```bash
npx tsc -p tsconfig.web.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "renderer: wire codex into TileTree dispatch + alt-c keybinds"
```

---

### Task 11: Provider-aware Feed rendering

**Files:**
- Modify: `src/renderer/src/feed/Feed.tsx`
- Create: `src/renderer/src/feed/codex/CodexRows.tsx`

- [ ] **Step 1: Add provider context to Feed**

Feed needs to know which provider it's rendering for so it can dispatch to the right row components. Add a `provider` prop to Feed:

```ts
type Props = {
  sessionId: string
  provider: 'claude' | 'codex'   // NEW
  entries: Entry[]
  ...
}
```

TileLeaf passes `provider={meta?.kind === 'codex' ? 'codex' : 'claude'}` from the workspace session meta.

- [ ] **Step 2: Create stub CodexRows.tsx**

Create `src/renderer/src/feed/codex/CodexRows.tsx` with placeholder row components that render codex entries. Start simple — just render text content from `response_item` entries:

```tsx
export const CodexTextRow = memo(function CodexTextRow({ text }: { text: string }) {
  return (
    <MarkerRow marker="▌">
      <TextProse text={text} />
    </MarkerRow>
  )
})
```

- [ ] **Step 3: Wire provider dispatch in Feed's Block component**

In Feed.tsx's `Block` component, check the provider context and dispatch tool_use blocks to the right provider's row components:

```ts
case 'tool_use': {
  const tu = block as ToolUseBlock
  if (provider === 'codex') {
    // Codex tool rendering — dispatch to CodexRows
    return <CodexToolRow block={tu} />
  }
  // Claude tool rendering (existing)
  switch (tu.name) { ... }
}
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc -p tsconfig.web.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feed: provider-aware row dispatch (claude vs codex)"
```

---

### Task 12: Testbench codex support (record + replay)

**Files:**
- Modify: `testbench/record.ts`
- Modify: `testbench/replay.ts`

- [ ] **Step 1: Wire CodexSession into record.ts**

Replace the TODO throw from Task 4 with actual CodexSession usage:

```ts
if (provider === 'codex') {
  const session = new CodexSession({ cwd: meta.cwd, ... })
  // Wire same event handlers as Claude path
}
```

- [ ] **Step 2: Wire codex parsers into replay.ts**

Replace the TODO throw from Task 4 with codex parser imports:

```ts
if (provider === 'codex') {
  const { extractCodexStreamingText, extractCodexAssistantInProgress } =
    await import('../src/core/parsers/codex/streamingScreen.js')
  // Run codex parsers instead of claude parsers
}
```

- [ ] **Step 3: Run a live codex recording to verify**

```bash
npm run record:codex
```

Interact with codex, verify the recording lands in `recordings/<ts>/`. Then:

```bash
npm run replay:codex -- recordings/<ts>
```

Verify the output shows raw screen + parsed output.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "testbench: wire CodexSession into record/replay"
```

---

### Task 13: PathPickerModal provider dropdown

**Files:**
- Modify: `src/renderer/src/tiles/PathPickerModal.tsx`

- [ ] **Step 1: Add a provider selector**

Add a simple toggle or dropdown at the top of the modal:
```tsx
<div className="flex gap-2 mb-3">
  <button
    onClick={() => setProvider('claude')}
    className={provider === 'claude' ? 'bg-accent text-accent-fg' : 'bg-surface text-muted'}
  >
    Claude
  </button>
  <button
    onClick={() => setProvider('codex')}
    className={provider === 'codex' ? 'bg-accent text-accent-fg' : 'bg-surface text-muted'}
  >
    Codex
  </button>
</div>
```

- [ ] **Step 2: Pass provider through onAccept**

Update `onAccept` to carry the provider:
```ts
onAccept: (expandedPath: string, provider: 'claude' | 'codex') => void
```

App.tsx's `onPathPickerAccept` passes it to `workspace.newTab(cwd, undefined, provider)`.

- [ ] **Step 3: Wire the resume list per provider**

When provider is 'codex', call a new `window.api.listCodexSessionsForCwd` (or a generalized version) that walks `~/.codex/sessions/` instead of `~/.claude/projects/`.

- [ ] **Step 4: Typecheck**

```bash
npx tsc -p tsconfig.web.json --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "PathPickerModal: provider dropdown (Claude / Codex)"
```

---

### Task 14: First live smoke test

- [ ] **Step 1: Build and run**

```bash
npm run dev
```

- [ ] **Step 2: Test Claude (regression)**

Open a Claude tab (⌘T), send a prompt, verify feed renders, streaming works, tool calls show diffs.

- [ ] **Step 3: Test Codex (new)**

Split with Alt+C, verify the codex binary spawns, the TUI renders in the streaming card, and basic interaction works.

- [ ] **Step 4: Test terminal (regression)**

Split with Alt+T, verify the shell prompt shows, keystrokes work.

- [ ] **Step 5: Test tab switching**

Switch between Claude, Codex, and Terminal tabs. Verify:
- Draft input persists per session
- Scroll position persists per session
- Streaming card shows/hides correctly

- [ ] **Step 6: Commit any fixes discovered during smoke test**

---

## Summary of separation of concerns

After all tasks are complete:

```
src/core/parsers/
  claude/                      — Claude-specific screen parsers
    streamingScreen.ts
    slashCommandPicker.ts
    trustDialog.ts
  codex/                       — Codex-specific screen parsers
    streamingScreen.ts
  lineDiff.ts                  — Shared (provider-agnostic)

src/core/types/
  transcript.ts                — Re-export hub
  claudeTranscript.ts          — Claude JSONL entry shapes
  codexTranscript.ts           — Codex rollout entry shapes

src/core/runtime/
  ptyScreen.ts                 — Shared PTY + headless xterm primitive
  claudeSession.ts             — Claude provider (composes PtyScreen)
  codexSession.ts              — Codex provider (composes PtyScreen)
  terminalSession.ts           — Plain shell (no PtyScreen, no scraping)
  jsonlTailer.ts               — Shared file tailer
  projectDir.ts                — Claude ~/.claude/projects/ path resolution
  codexProjectDir.ts           — Codex ~/.codex/sessions/ path resolution
  sessionList.ts               — Claude session list
  codexSessionList.ts          — Codex session list

src/renderer/src/feed/
  Feed.tsx                     — Shared framework (scroll, memo, streaming card)
  claude/ClaudeRows.tsx        — Claude tool row renderers (Edit, Write, Todo, etc.)
  codex/CodexRows.tsx          — Codex row renderers
  ThemePicker.tsx              — Shared
  TrustDialogModal.tsx         — Claude-specific (moved to claude/ later if needed)

src/renderer/src/tiles/
  TileLeaf.tsx                 — Shared agent pane (both Claude and Codex)
  TerminalLeaf.tsx             — Plain terminal pane
  TileTree.tsx                 — Dispatches by kind
  workspaceStore.ts            — Provider-aware spawn/rehydrate/event-handling
  useKeybinds.ts               — alt-d (claude split), alt-c (codex split), alt-t (terminal)
  types.ts                     — SessionKind = 'claude' | 'codex' | 'terminal'
```

No Claude logic in codex files. No codex logic in Claude files. Shared infrastructure in provider-agnostic files that both compose.
