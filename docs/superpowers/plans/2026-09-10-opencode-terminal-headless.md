# OpenCode Terminal Headless Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenCode Terminal agents report real status, raise attention for permission/question prompts, and serve every MCP read path. This is done through a new PTY headless package, `opencode-terminal-headless`, that reads OpenCode's channels the way `claude-code-headless` and `codex-headless` read theirs.

**Architecture:** The package reads two channels, each owning different signals. The durable channel is OpenCode's SQLite event log, opened read-only; it owns committed `{ info, parts }` messages and history. The live channel is the TUI's own HTTP/SSE server, reached through `--port` plus a per-spawn password; it owns activity, turns and conditions. There is no screen mirror. A single isolated sequencer orders the two sources. Agent Code wraps the package in a thin adapter, the job `claudeSession.ts` does for Claude, and gains an OpenCode history source for its read paths.

**Tech Stack:** TypeScript, Node 24 `node:sqlite` (Electron 43 bundles Node 24.18), node-pty (caller-owned), Vitest 4, git submodules.

**Spec:** `docs/decomposition/opencode-terminal-headless.md` (stages, pipeline, owners, unknowns, fixture plan). Issue #864, fixes #857. The package-side tasks (Stages 0–4) live in the package repository's own plan, `packages/opencode-terminal-headless/docs/plans/2026-09-10-initial-runtime.md`. This document covers the Agent Code side (Stages 4–6) and the order across both repositories.

## Global Constraints

- Minimum OpenCode for the durable channel: **1.18.27** (first version whose sessions carry `event` rows by default). Anything older degrades to today's behavior plus a diagnostic.
- The durable channel is **read-only**. Agent Code and the package never write `opencode.db`. Session creation, switch, duplicate and rewind stay on `opencode import`/`export` (`src/providers/opencode/runtime/opencodeCliSessions.ts`).
- The TUI server binds `127.0.0.1` only, on a freshly allocated port, with a fresh random password per spawn. Neither is persisted. Agent panes are not tmux-backed and respawn on restart, so there is nothing to persist.
- Semantic events use `source: 'opencode-sse'`. They genuinely come from OpenCode's SSE bus, and the renderer's `OPENCODE_SEMANTIC_FOLD_POLICY` is already keyed on that source.
- Condition kinds and custom action names are identical to the structured runtime: `opencode.permission` / `opencode.question`, `opencode.permission.reply` / `opencode.question.reject`. Payloads are `{ requestID, reply }` / `{ questionID }`.
- Committed transcript entries use the file string `opencode://session/<ses_id>`.
- Node **24** for every test run (`source /opt/homebrew/opt/nvm/nvm.sh && nvm use 24`). Node 25 breaks happy-dom's `localStorage` in the renderer suite.
- The type gate is raw `tsc` (`npm run typecheck`). electron-vite and vitest do not type-check.
- Never launch Agent Code (`npm run dev`, `npx electron`). The package's live probe runs the real `opencode` binary in an isolated HOME/XDG sandbox with a free `opencode/*` model. That is not an Agent Code launch.
- Conventional Commits with a subsystem scope. Identity comes from the global git config (`julius.olsson05@gmail.com`). Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01VXcU2JMay6xCk8NKJ6cTgj
  ```
- Thick WHY comments on every non-obvious line. No CI grep locks, no speculative guards.
- Open PRs; never merge without explicit confirmation. When authorized: `gh pr merge <n> --merge`.

---

## Cross-repository order

1. **Task 0** (this plan plus the decomposition) is the first commit on `feat/opencode-terminal-headless`.
2. **Package Stages 0–4** run inside `packages/opencode-terminal-headless` on its branch `feat/initial-runtime`, following its own plan. They end with a pushed branch and an open package PR.
3. **Tasks 1–5** below run in this worktree against the pushed package commit.
4. **Task 6** verifies both repositories and opens the Agent Code PR. Its submodule pointer must be a commit that is already pushed, or CI's recursive checkout fails.

---

## Execution notes (2026-09-11)

Tasks 0–5 are implemented and committed on `feat/opencode-terminal-headless`:
`3b1f6449` (plan), `6d274bad` (Stage 0 evidence), `0fc879ad` (wiring),
`f0b170b8` (adapter), `81929238` (renderer end-to-end test), `2a99d6c0`
(history source), `e9d6c0b5` (terminal-pane history), `c58ab1e9` (MCP
transcript tools).

- The "confirm it fails" steps are left unticked on purpose. Each task's
  tests were run green before its commit, but a red run before the
  implementation was not recorded, so it is not claimed.
- Task 4 touched eight skip sites, not four: spawn seeding and load,
  wake, rehydrate seeding and load, reload-all seeding, older-history
  paging, and the initial loader itself. Adoption was already calling the
  loader and got stuck on `loading` because of the skip.
- Task 5 went further than planned:
  - The package gained `iterateMessages` (a forward walk, one read
    transaction per page) and owns the `opencode://session/<id>` format
    through `opencodeTranscriptFile` and `parseOpencodeTranscriptFile`.
  - A shared `opencodeDatabase` handle replaced the history source's
    private one.
  - `transcriptLocator` routes locators for Agent Management.
  - Remote get-history reads OpenCode.
  - `provider_managed` is retired, and the reader's dead `parseTranscript`
    path is removed.

After Task 5, before the PRs:

- **`186f19e6`**: View Prompts, Dispatch titles and composer history were
  empty for every OpenCode session. A Claude-only `permissionMode` filter
  caused it, and it would have made Task 4's stated benefit false. The
  OpenCode feed mapper also stopped rendering OpenCode's synthetic text.
- **An independent review of the branch** found five defects. Four are fixed,
  in package `13b9f5c` and Agent Code `44a5677c`:
  - MCP reads of long sessions blocked the main process.
  - History could land out of order.
  - A transient BUSY disabled the durable channel for good.
  - The live re-sync could apply stale or partial state.
  - The fifth, a pane silently dead after losing its port, has a smaller
    window now, and surfacing it is filed as #881.
- **Bugs found along the way, verified against current code and filed:**
  - #877: prompts pasted into a just-started OpenCode Terminal pane are lost.
  - #878: the structured runtime's permission/question text is empty on 1.18.30.
  - #879: `replaceSession` strips orchestration metadata.
  - #875: `observations.wait` never settles for agents.
  - #880: a missing runtime is counted as running.

---

### Task 0: Decomposition and plan

**Files:**
- Create: `docs/decomposition/opencode-terminal-headless.md`
- Create: `docs/superpowers/plans/2026-09-10-opencode-terminal-headless.md`

- [x] **Step 1: Commit both documents as the branch's first commit**

```bash
git add docs/decomposition/opencode-terminal-headless.md docs/superpowers/plans/2026-09-10-opencode-terminal-headless.md
git commit -m "docs(opencode): plan the OpenCode Terminal headless read pipeline" -m "Refs #864"
```

---

### Task 1: Submodule and build wiring (Stage 4, Agent Code side)

**Files:**
- Modify: `.gitmodules` (new `packages/opencode-terminal-headless` entry)
- Modify: `electron.vite.config.ts` (`headlessAlias`, `headlessExclude`)
- Modify: `tsconfig.node.json` and `tsconfig.web.json` (`paths`, `include`, if the siblings are listed there)
- Modify: `vitest.config.ts` (alias list next to `opencode-headless`)
- Modify: `scripts/sync-conditions-core.mjs` (`TARGETS` entry, `sync: true`)

**Interfaces:**
- Produces: the import specifier `opencode-terminal-headless`, which resolves to `packages/opencode-terminal-headless/src/index.ts` in main, preload and tests. The renderer never imports it; it uses `node:sqlite` and `node-pty` types.

- [x] **Step 1: Add the submodule at the package branch's pushed commit**

```bash
git submodule add https://github.com/Juliusolsson05/opencode-terminal-headless.git packages/opencode-terminal-headless
git -C packages/opencode-terminal-headless checkout <pushed feat/initial-runtime sha>
```

- [x] **Step 2: Add aliases.** Copy the existing `opencode-headless` entries in each of the four config files and rename them. In `electron.vite.config.ts`, the subpath regex goes *before* the bare specifier, matching the siblings, because alias order matters.

```ts
{ find: /^opencode-terminal-headless\/(.+)$/, replacement: `${resolve(__dirname, 'packages/opencode-terminal-headless/src')}/$1` },
{ find: 'opencode-terminal-headless', replacement: resolve(__dirname, 'packages/opencode-terminal-headless/src/index.ts') },
```

Also add `'opencode-terminal-headless'` to `headlessExclude`, so main compiles it from source instead of externalizing it.

- [x] **Step 3: Add the conditions-core target and run the sync**

```js
{
  name: 'opencode-terminal-headless',
  dest: path.join(REPO_ROOT, 'packages', 'opencode-terminal-headless', 'src', 'conditions', 'core'),
  sync: true,
},
```

Run: `node scripts/sync-conditions-core.mjs && node scripts/sync-conditions-core.mjs --check`
Expected: the check exits 0.

- [x] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: exit 0 (nothing imports the package yet, so this proves only that the config parses).

- [x] **Step 5: Commit**

```bash
git add .gitmodules packages/opencode-terminal-headless electron.vite.config.ts tsconfig.node.json tsconfig.web.json vitest.config.ts scripts/sync-conditions-core.mjs
git commit -m "build(opencode): wire the opencode-terminal-headless submodule into the app build" -m "Refs #864"
```

---

### Task 2: OpenCode Terminal runtime adapter (Stage 5)

**Files:**
- Modify: `src/providers/opencode/runtime/opencodeTerminalSession.ts`
- Modify: `src/providers/opencode/runtime/opencodeTerminalSession.test.ts`

**Interfaces:**
- Consumes (package root):
  - `prepareOpencodeTerminalLaunch(opts: { binary: string; cwd: string; env: Record<string, string>; sessionID: string; dangerousMode: boolean }): Promise<OpencodeTerminalLaunch>`
  - `OpencodeTerminalLaunch = { binary: string; args: string[]; env: Record<string, string>; sessionID: string; server: { url: string; username: string; password: string }; dbPath: string | null }`
  - `new OpencodeTerminalHeadless({ pty, cwd, launch })`
  - Headless events:
    - `activity: [{ active: boolean; status: string | null }]`
    - `semantic: [SemanticEvent]`
    - `entry: [OpencodeMessageRecord]`
    - `'transcript-error': [Error & { code: string }]`
    - `conditions: [ProviderConditionSnapshot]`
    - `'live-state': [{ connected: boolean; reason?: string }]`
  - Headless methods: `resolveConditionAction(action: ConditionCustomAction): Promise<{ ok: true } | { ok: false; reason: string; failedAtStep?: string }>`, `start(): Promise<void>`, `stop(): Promise<void>`, `write(data)`, `resize(cols, rows)`, `pasteAndSubmit(text)`.
- Produces: the unchanged `AgentSession` surface, plus `resolveCondition` (new for this runtime).

- [x] **Step 1: Write the failing adapter tests.** Inject a fake headless factory and a fake PTY spawner (both constructor options that default to the real ones). Assert:
  - headless `activity {active:true,status:'busy'}` → `process-state {active:true,status:'busy'}`
  - headless `entry(record)` → `jsonl-entry(record, 'opencode://session/ses_x')`
  - headless `semantic(ev)` → `semantic-event(ev)`
  - headless `conditions(snap)` → `conditions(snap)`
  - `transcript-error` → `jsonl-error`
  - `resolveCondition(action)` delegates to the headless and returns its result verbatim
  - PTY exit → `process-state false`, then `exit`; the headless is stopped exactly once
  - the identity-only entry is still emitted at start, so fresh-session identity capture keeps working

- [ ] **Step 2: Run the tests.** `NODE_ENV=test npx vitest run --project unit src/providers/opencode/runtime/opencodeTerminalSession.test.ts` fails, because the adapter has no headless yet.

- [x] **Step 3: Rewrite the adapter.**
  - Keep: env assembly, `addOpencodeBuiltInMcpLaunchConfig`, `excludeExternalControlFromOpencode`, `createEmptyOpencodeSession` for fresh sessions, the generation fence, readiness (first byte + 250 ms), `deliverPromptText` (now calls `headless.pasteAndSubmit`), and its `OpencodeTerminalNotReadyError`.
  - Replace the bare `ptySpawn(binary, args)` with the sequence below, and forward the headless events per Step 1.
  - `stop()`: `headless.stop()`, then `pty.kill()`. Both are idempotent.

```ts
const launch = await prepareOpencodeTerminalLaunch({ binary, cwd, env, sessionID, dangerousMode })
const pty = ptySpawn(launch.binary, launch.args, { name: 'xterm-256color', cols, rows, cwd, env: launch.env })
const headless = new OpencodeTerminalHeadless({ pty, cwd, launch })
await headless.start()
```

- [x] **Step 4: Run the tests.** They pass.

- [x] **Step 5: Commit** `feat(opencode): read OpenCode Terminal status and transcript through opencode-terminal-headless` (`Refs #864`, `Refs #857`).

---

### Task 3: OpenCode history source in main (Stage 6)

**Files:**
- Modify: `src/providers/registry.main.ts` (new optional `loadHistoryChunk` hook on `MainProviderConfig`; the OpenCode config implements it)
- Create: `src/main/sessions/opencodeHistory.ts` (db-path memo, store lifetime, record → loader-chunk mapping)
- Modify: `src/main/sessions/historyLoader.ts` (`loadInitialHistoryChunk` / older-chunk: delegate when the provider has the hook)
- Create: `src/main/sessions/opencodeHistory.system.test.ts`

**Interfaces:**
- Consumes (package root): `openOpencodeStore(dbPath: string): OpencodeStore`, `resolveOpencodeDbPath({ binary, env }): Promise<string>`, and `OpencodeStore.readHistory(sessionID, { limit, beforeMessageID? }): { records: OpencodeMessageRecord[]; hasOlder: boolean }`.
- Produces: `loadOpencodeHistoryChunk({ cwd, providerSessionId, limit, beforeMessageID? }): Promise<HistoryChunk>`. The `entries` are `{ info, parts }` records, which is exactly what the renderer's OpenCode mapper already folds.

- [x] **Step 1: Write the failing system test.** Create a temporary SQLite database with the production DDL (copied from the package's `testing/fixtures/schema.sql`), load one Stage 0 durable fixture, and point the resolver at it. Then:
  - `loadInitialHistoryChunk({ kind: 'opencode', providerSessionId, cwd, limit: 2 })` returns the two newest completed records with `hasMore: true`.
  - A second call with the oldest id returns the rest with `hasMore: false`.
- [ ] **Step 2: Run it** and confirm it fails.
- [x] **Step 3: Implement.**
  - Stores are memoized per db path and released on app quit.
  - Store errors become an empty chunk plus a `performanceService` span failure. The loader never throws into the renderer, matching the missing-file behavior.
- [x] **Step 4: Run it** and confirm it passes.
- [x] **Step 5: Commit** `feat(opencode): load OpenCode history from the durable store` (`Refs #864`).

---

### Task 4: Renderer history for terminal-runtime panes (Stage 6)

**Files:**
- Modify: `src/renderer/src/workspace/hook/actions/initialHistory.ts:93-96`
- Modify: `src/renderer/src/workspace/hook/actions/history.ts:52-56`
- Modify: `src/renderer/src/workspace/hook/actions/session.ts:482-503`
- Modify: `src/renderer/src/workspace/hook/persistence/rehydrate.ts` (the two terminal skips)
- Test: `src/renderer/src/workspace/hook/actions/sessionRecovery.renderer.test.tsx` or a new focused `*.renderer.test.tsx`

**Interfaces:**
- Consumes: Task 3's loader, through the existing `session:load-initial-history` IPC. No new IPC.

- [x] **Step 1: Write the failing renderer test.**
  - An OpenCode session meta with `providerRuntime: 'terminal'` and a `providerSessionId` calls `loadInitialHistoryForSession`.
  - The runtime ends with the mapped entries.
  - `resolveAgentDisplayMode` still returns `'terminal'`, so no feed is mounted.
  - Commands gated by `commandAllowedByRenderedViewPolicy` stay hidden.
- [ ] **Step 2: Run it** and confirm it fails.
- [x] **Step 3: Remove the `providerRuntime === 'terminal'` skip** from the four history sites.
  - Replace each skip's WHY comment with the new reason: the terminal pane stays raw, but agents, Dispatch and MCP readers need the conversation in `runtime.entries`, and the durable store makes loading it cheap (no CLI process).
  - Keep the spawn-seed for terminal (`transcriptStatus: 'ready'`, `hasOlderHistory: false`) only where history is genuinely absent.
- [x] **Step 4: Run it** and confirm it passes.
- [x] **Step 5: Commit** `feat(workspace): load conversation history for OpenCode Terminal panes` (`Refs #864`).

---

### Task 5: MCP transcript tools and Agent Management locator (Stage 6)

**Files:**
- Modify: `src/main/agentTranscripts/AgentTranscriptReader.ts`
  - `preparePath`: accept `opencode://session/<id>`.
  - `resolveProvider`: add `'opencode'`.
  - `detectProvider`: the scheme implies OpenCode.
  - Add an OpenCode item extractor next to `extractClaudeItems`/`extractCodexItems`.
  - Replace the three two-way ternaries with an exhaustive switch.
- Modify: `src/mcp/runtime/createBuiltInMcpServer.ts` (tool descriptions: "Claude, Codex or OpenCode"; mention the `opencode://session/<id>` locator)
- Modify: `src/main/agentManagement/AgentManagementBridge.ts:479-560`: for OpenCode, publish `path: opencode://session/<id>` and `availability: 'available'` when the store can read the session; `modifiedAt` comes from the session's `time_updated`.
- Test: `src/main/agentTranscripts/AgentTranscriptReader.opencode.system.test.ts`

**Interfaces:**
- Consumes: `OpencodeStore.readHistory(sessionID, { limit: Infinity })`, or a streaming `iterateMessages(sessionID)` if Stage 1 provides one for large sessions.

- [x] **Step 1: Write the failing tests** over a fixture database. For `read_file` / `search_file` / `inspect_file` with `opencode://session/<id>`, the extracted items must be:
  - user text
  - assistant text
  - tool calls with name and target: `filePath` for read/edit/write, `command` for bash, the patch for `apply_patch`
  - tool results

  Also assert `todowrite` is not classified as a file write.
- [ ] **Step 2: Run them** and confirm they fail.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run them** and confirm they pass.
- [x] **Step 5: Commit** `feat(mcp): read OpenCode sessions through the agent transcript tools` (`Refs #864`).

---

### Task 6: Verification and PRs

- [x] **Step 1: Run the package gate.** `cd packages/opencode-terminal-headless && npm run check`, on Node 24 and 22.12 if available.
- [x] **Step 2: Run the Agent Code gates:**
  - `npm run typecheck`
  - `npm run test:contract`
  - `node scripts/sync-conditions-core.mjs --check`
  - `npm test`, run once (Node 24)
  - `npm run test:package`
- [x] **Step 3: Review the diff.** Run `git diff origin/main...HEAD --stat` and read every hunk for unrelated changes.
- [x] **Step 4: Open the PRs.**
  - Package PR first.
  - Then the Agent Code PR: `Fixes #864`, `Fixes #857`, `Refs #843`, `Refs Juliusolsson05/opencode-headless#3`, and a link to the package PR.
  - Mark the decomposition's Status and this plan's checkboxes.
- [x] **Step 5: Report and stop.** Opened Juliusolsson05/opencode-terminal-headless#1 and #882; not merged.
  Original step: No merge without explicit confirmation. Merge order once confirmed: the package PR, then bump the pointer to the merged package commit, re-run CI, then the Agent Code PR.
