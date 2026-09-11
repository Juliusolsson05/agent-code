# Reader Mode Transcript Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reader Mode shows only transcript-derived assistant prose (committed entries plus ledger-approved semantic text) and never text scraped from the terminal screen; the renderer stops screen-scraping assistant text altogether.

**Architecture:** `ReaderView` consumes the same ledger feed plan (`useLedgerFeedItems`) that `Feed` paints and projects it to Reader messages through one pure function, `readerMessagesFromFeedItems`. The ledger already owns the decisions Reader used to re-derive badly: live-vs-committed ownership, compaction-synthesis refusal (#345), sidechain exclusion and semantic block classification. The submit-time "streaming baseline" (a screen scrape now read only by the debug panel) is deleted with the `@shared/parsers` wrappers that only it and Reader used.

**Tech Stack:** TypeScript, React 18, Vitest 4 (`unit` node project, `renderer` happy-dom project).

**Spec:** GitHub issue #855 (root cause, reproduction, acceptance criteria).

## Global Constraints

- Worktree `.worktrees/reader-mode-transcript-source`, branch `fix/reader-mode-transcript-source`, based on `origin/main` @ `48ea6912`.
- Node 24 for every test run: `source /opt/homebrew/opt/nvm/nvm.sh && nvm use 24` (the machine default v25 breaks happy-dom `localStorage`).
- Type gate is raw tsc: `npx tsc -p tsconfig.node.json --pretty false && npx tsc -p tsconfig.web.json --pretty false`; `npm run typecheck` before the PR.
- Single-file test runs: `NODE_ENV=test npx vitest run --project unit <path>` / `--project renderer <path>`. Full `npm test` once, at the end.
- Never launch the app.
- No changes under `packages/`. The Claude `ScreenParser` misreading `⏺ main` stays as a package follow-up: after this PR it is reachable only through the headless debug shadow channel.
- Thick WHY comments on every non-obvious decision. Conventional Commits, scopes `reader` / `renderer`.

## Root cause (from #855, verified before this plan)

1. `ReaderView` (`src/renderer/src/features/reader/ui/ReaderView.tsx:175-186`) uses `runtime.semantic.currentTurn.text` while `sessionStatus === 'running'`, and when that is empty calls `extractAssistantInProgress(runtime.recentScreen, provider)`. Screen text has not reached `runtime.semantic` since the 2026-04-18 headless redesign (it goes to `semanticShadow` in both headless packages), so the scraper is the path whenever a turn runs with no open text stream: tool execution, waiting on subagents, proxy off.
2. Claude Code's `CoordinatorTaskPanel` (`vendor/claude-code-src/full/components/CoordinatorAgentStatus.tsx`) renders under the prompt footer: `  ⏺ main` (`BLACK_CIRCLE` is `⏺` on darwin) then `  ◯ <agent>  <description> ▶ <elapsed> · ↓ <n> tokens` per agent. The scraper's "last `⏺` line starts the assistant block" rule lands on `⏺ main`. A scratch run of `packages/claude-code-headless/src/parsers/ScreenParser.ts` on that layout returned `"main\n◯ general-purpose  Comparing SessionList.ts copies ▶ 14m 41s · ↓ 550.2k tokens\n…"`; without the panel it returned the real assistant sentence.
3. By code reading, the same ad-hoc path would stream a compaction-synthesis turn's `<analysis>/<summary>` XML into Reader, because it reads `currentTurn.text` without the flag the ledger honours.

## File map

| File | Change | Task |
|---|---|---|
| `src/renderer/src/features/reader/model/readerMessages.ts` | Create: pure projection `FeedRenderItem[] → ReaderMessage[]` | 1 |
| `src/renderer/src/features/reader/model/readerMessages.test.ts` | Create: projection over real adapter → ledger → bridge output | 1 |
| `src/renderer/src/features/reader/ui/ReaderView.tsx` | Modify: consume `useLedgerFeedItems`, delete the screen fallback | 1 |
| `src/renderer/src/features/reader/ui/ReaderView.renderer.test.tsx` | Modify: #855 regression, live streaming, compaction | 1 |
| `src/renderer/src/rendering/observations/semantic.ts` | Modify: export `blockContentKind` | 1 |
| `src/renderer/src/features/copy-assistant/lib/extractAssistantByUuid.ts` | Modify: extract `assistantEntryText`, single-pass `assistantUuidsWithText` | 1 |
| `src/renderer/src/workspace/tile-tree/TileLeaf/useComposerKeybinds.ts` | Modify: drop the baseline scrape, call `beginOptimisticSubmit` | 2 |
| `src/renderer/src/workspace/hook/actions/streaming.ts` | Modify: rename to `beginOptimisticSubmit` / `unwindOptimisticSubmit`, drop the baseline | 2 |
| `src/renderer/src/workspace/hook/index.ts` | Modify: renamed actions | 2 |
| `src/renderer/src/session-runtime/state.ts` | Modify: delete `streamingBaseline` | 2 |
| `src/renderer/src/features/debug/ui/DebugPanel.tsx` | Modify: delete the "streaming baseline" section | 2 |
| `src/renderer/src/workspace/tile-tree/TileLeaf.tsx`, `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` | Modify: correct stale comments | 2 |
| `src/renderer/src/workspace/hook/actions/streamingUnwind.renderer.test.tsx`, `streamingUnwind.test.ts` | Modify: renamed action, no baseline field | 2 |
| `src/shared/parsers/extractAssistant.ts`, `claudeScreen.ts`, `codexScreen.ts` | Delete (only importers are the two call sites removed here) | 2 |

---

### Task 1: Reader messages come from the render ledger

**Interfaces:**
- Produces `readerMessagesFromFeedItems(items: readonly FeedRenderItem[]): ReaderMessage[]` and `type ReaderMessage = { id: string; text: string; live: boolean }` from `@renderer/features/reader/model/readerMessages`.
- Produces `assistantEntryText(entry: Entry): string | null` from `@renderer/features/copy-assistant/lib/extractAssistantByUuid`.
- Produces exported `blockContentKind(b: SemanticBlockLike): RenderCandidate['contentKind']` from `@renderer/rendering/observations/semantic`.

- [ ] **Step 1: Write the failing ReaderView regression tests**

Refactor the existing `makeReaderWorkspace()` in `ReaderView.renderer.test.tsx` to take a runtime (default: the two committed answers it builds today), then add:

```tsx
const T = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

// Row format from vendor/claude-code-src/full/components/CoordinatorAgentStatus.tsx
// (MainLine / AgentLine) and the literal text reported in #855. The panel is
// drawn BELOW the prompt footer, which is what defeats the scraper.
const BACKGROUND_AGENT_PANEL_SCREEN = [
  '⏺ I will dispatch four agents to investigate the reader bug in parallel.',
  '',
  '⏺ 4 general-purpose agents launched (ctrl+o to expand)',
  '',
  '✻ Cogitating… (esc to interrupt)',
  '',
  '─'.repeat(100),
  '❯ ',
  '─'.repeat(100),
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  '',
  '  ⏺ main',
  '  ◯ general-purpose  Comparing SessionList.ts copies ▶ 14m 41s · ↓ 550.2k tokens',
  '  ◯ general-purpose (+3)  Reading AgentTerminalLeaf status chrome ▶ 14m 24s · ↓ 309.7k tokens',
].join('\n')

function foldClaude(runtime: SessionRuntime, events: Record<string, unknown>[]): SessionRuntime {
  let semantic = runtime.semantic
  for (const event of events) semantic = foldSemanticEvent(semantic, event, 'claude')
  return { ...runtime, semantic }
}

it('never presents Claude background-agent panel rows as the live message (#855)', () => { … })
it('follows streaming semantic text as the newest message and ignores thinking', () => { … })
it('never shows a compaction synthesis turn', () => { … })
```

Runtime for the #855 test: `sessionStatus: 'running'`, `screen` and `recentScreen` set to the panel screen, `semantic.currentTurn` null, entries = one timestamped user prompt at `T` and one assistant answer at `T + 100`. Assert the committed answer is visible, `queryByText(/general-purpose/)` is null and the pager reads `1 / 1`.

Streaming test: fold `turn_started` (`source: 'proxy'`), a `thinking` block with a `thinking_delta`, a `text` block with `text_delta` `textSoFar: 'Streaming answer so far'`. Assert that text is shown, the thinking text is not, pager `2 / 2`.

Compaction test: fold `turn_started` with `isCompactionSynthesis: true`, a `turn_delta` whose `fullText` is `<analysis>private scratch</analysis>`, and a text block carrying the same text. Assert `queryByText(/private scratch/)` is null and the committed answer is shown.

- [ ] **Step 2: Run them and confirm the #855 and compaction tests fail on the current code**

`NODE_ENV=test npx vitest run --project renderer src/renderer/src/features/reader/ui/ReaderView.renderer.test.tsx`

Expected: the #855 test fails (panel text is rendered, pager `2 / 2`), the compaction test fails (XML is rendered), the streaming test fails (thinking-free live block not shown because the old path reads `turn.text`).

- [ ] **Step 3: Export the ledger's block classifier**

In `rendering/observations/semantic.ts` change `function blockContentKind` to `export function blockContentKind` and add a WHY comment: Reader must classify semantic blocks with the ledger's own vocabulary, or the two surfaces disagree about what counts as prose.

- [ ] **Step 4: Extract `assistantEntryText`**

In `features/copy-assistant/lib/extractAssistantByUuid.ts`, move the text concatenation out of `extractAssistantByUuid` into `export function assistantEntryText(entry: Entry): string | null` (returns null for non-assistant entries and entries without text), make `extractAssistantByUuid` call it, and make `assistantUuidsWithText` call `assistantEntryText(entry)` directly instead of re-scanning the list per uuid (the O(n²) rescan).

- [ ] **Step 5: Write the projection**

`features/reader/model/readerMessages.ts`:

```ts
export type ReaderMessage = { id: string; text: string; live: boolean }

export function readerMessagesFromFeedItems(items: readonly FeedRenderItem[]): ReaderMessage[] {
  const messages: ReaderMessage[] = []
  for (const item of items) {
    switch (item.type) {
      case 'entry': {
        const text = assistantEntryText(item.entry)
        if (text) messages.push({ id: item.key, text, live: false })
        break
      }
      case 'semantic-text': {
        const text = item.text.trim()
        if (text) messages.push({ id: item.key, text, live: item.owner === 'semantic-current' })
        break
      }
      case 'semantic-block': {
        if (blockContentKind(item.block) !== 'assistant-text') break
        const text = item.block.text?.trim()
        if (text) messages.push({ id: item.key, text, live: item.owner === 'semantic-current' })
        break
      }
      default:
        break
    }
  }
  return messages
}
```

Each skipped item type gets a WHY comment (absorbed entries paint nothing in Feed, collapsed activity / work / empty are not prose).

- [ ] **Step 6: Unit-test the projection over the real pipeline**

`features/reader/model/readerMessages.test.ts` builds a runtime (entries + `foldSemanticEvent`), runs `createLedgerInputAdapter()` → `createSessionLedger()` → `providerLedgerFeedContextFromRuntime` → `ledgerToFeedItems` exactly as `useLedgerFeedItems` does, and asserts:
1. committed assistant prose and a streaming text block come out in feed order with `live` false / true; a tool-only assistant entry, a thinking block and a tool block produce nothing;
2. a finalized semantic history turn whose text the transcript already committed (same `message.id` as the turn id) yields exactly one message, the committed entry.

- [ ] **Step 7: Rewire ReaderView**

Replace the `messages` memo with:

```tsx
const ledgerFeedPlan = useLedgerFeedItems(runtime, provider, sessionId, {
  toolUseIndex: runtime.toolUseIndex,
  toolResultIndex: runtime.toolResultIndex,
  version: runtime.toolIndexVersion,
})
const messages = useMemo(
  () => readerMessagesFromFeedItems(ledgerFeedPlan.items),
  [ledgerFeedPlan.items],
)
```

Delete `extractAssistantInProgress`, `semanticLive`, `hasLiveActivity` and the `assistantUuidsWithText` / `extractAssistantByUuid` imports. Rewrite the file header, the provider comment and the selection-snap comment (which still describes the `'__live__'` sentinel) to describe the ledger source.

- [ ] **Step 8: Run the Reader tests, then the type gate**

Both test files pass; `tsc` for node and web is clean.

- [ ] **Step 9: Commit**

`fix(reader): build Reader Mode from the render ledger instead of the terminal screen` with a body explaining the panel misparse and `Refs #855`.

---

### Task 2: Remove the renderer's last assistant-text screen scrape

**Interfaces:**
- Consumes nothing from Task 1.
- Produces `beginOptimisticSubmit(sessionId: SessionId): void` and `unwindOptimisticSubmit(sessionId: SessionId): void` on the workspace (renamed from `setStreamingBaseline` / `unwindStreamingBaseline`); `SessionRuntime.streamingBaseline` no longer exists.

- [ ] **Step 1: Delete the baseline end to end**
  - `useComposerKeybinds.ts`: remove the `extractAssistantInProgress` import, the `screen` / `baseline` lines and their comment; call `workspace.beginOptimisticSubmit(sessionId)`; rename the `unwindStreamingBaseline` call and comment.
  - `streaming.ts`: rename both actions; `beginOptimisticSubmit(sessionId)` no longer writes a baseline; the feed-debug entry keeps `summary: 'submit started'` and drops the baseline data; `unwindOptimisticSubmit` stops clearing the deleted field. Update the header comment and the WHY text that names the old action.
  - `hook/index.ts`: renamed actions in both places.
  - `state.ts`: remove `streamingBaseline` from `SessionRuntime` and `emptyRuntime()`; update the `submittedAt` doc comment.
  - `DebugPanel.tsx`: remove the "streaming baseline" section.
  - `TileLeaf.tsx` (Feed props comment) and `useIpcSubscriptions.ts` (`setStreamingBaseline never` comment): correct them. Screen text reaches only the headless shadow channel, never `runtime.semantic`.
  - `streamingUnwind.renderer.test.tsx` / `streamingUnwind.test.ts`: renamed action, fixtures without `streamingBaseline`, drop the `streamingBaseline` assertion.
  - Delete `src/shared/parsers/extractAssistant.ts`, `claudeScreen.ts`, `codexScreen.ts`.

- [ ] **Step 2: Prove nothing in the renderer scrapes assistant text**

`git grep -n "extractAssistantInProgress\|streamingBaseline\|StreamingBaseline" -- src` returns nothing.

- [ ] **Step 3: Type gate and affected tests**

`tsc` node + web clean; `streamingUnwind.*` and the Reader tests pass.

- [ ] **Step 4: Commit**

`refactor(renderer): drop the submit-time screen baseline and the assistant screen extractor` with `Refs #855 #762`.

---

### Task 3: Verify and open the PR

- [ ] `npm run typecheck`, then `npm test` once.
- [ ] Review `git diff origin/main...HEAD` for unrelated changes.
- [ ] Push and open `fix(reader): build Reader Mode from the render ledger instead of the terminal screen` with `Fixes #855`, `Refs #762`, the verification output, and the follow-ups: the headless `ScreenParser` still misreads `⏺ main` (debug shadow channel only now), and Reader's local markdown components use `engine="monaco"` where Feed uses `"static"`, so they were not merged. Do not merge.

## Self-review

- Every acceptance criterion in #855 maps to a test: panel regression (Task 1 Step 1), live handoff without duplicates (Task 1 Step 6.2), compaction (Task 1 Step 1), no renderer extractor caller (Task 2 Step 2).
- Names are consistent: `readerMessagesFromFeedItems`, `ReaderMessage`, `assistantEntryText`, `blockContentKind`, `beginOptimisticSubmit`, `unwindOptimisticSubmit`.

## Review round (PR #861, 2026-09-10)

Two orchestrated reviewers (A: Reader correctness, Claude; B: removal, tests and claims, Codex) reviewed `583cda68`. Each finding was verified against a reproduction before acting.

| Finding | Disposition |
|---|---|
| A-MAJOR: an older message the reader paged back to jumps to the newest message when its JSONL copy replaces the semantic-history copy (id `semantic-block:…` → `entry:…`) | Fixed. `features/reader/model/readerSelection.ts` follows an older selection to its committed twin by the ledger's normalised text, nearest the old position; with no twin it holds the distance from the end. |
| B-MAJOR / A-NIT: Reader does not follow a live turn onto its next text block | Fixed. A reader on the newest message follows onto newer messages; one who chose an older message stays. |
| A-MINOR: scroll jumps to the top when a block finishes streaming and again at the committed handoff; finished text in a turn held open for pending tools counted as live | Fixed. Scroll resets only when the reader lands on a different message (`ReaderSelection.moved`); `ReaderMessage.live` now means "still growing" (the ledger's terminal-block rule). |
| Selection was reconciled in an effect, so a handoff painted one frame of the newest message | Fixed while addressing the above: selection is reconciled during render. |
| B-MINOR: the streaming test's trace lacked the proxy's `turn_delta`, overstating red-first evidence | Fixed. Tests use the production trace (`text_delta` + `turn_delta`); the PR body no longer claims that test failed on `main`. |
| A-NIT: the ReaderView "leaves thinking out" check could not catch a classifier regression | Fixed. The trace completes the thinking block with `text`, as the proxy does. |
| A-MINOR: no view-level handoff test, no non-Claude coverage | Fixed. ReaderView "keeps its place" tests; Codex rollout, Codex proxy and OpenCode projection tests. |
| A-NIT: two comments overstated ledger caching / identity; per-delta O(entries) text joins | Fixed. Comments reworded; committed entry text memoised in a WeakMap. |
| A-MINOR: Claude with proxy streaming off shows no live text in Reader | Not adopted. It is the intended consequence of removing screen scraping (the user's report was the objection to it) and is disclosed in the PR. |
