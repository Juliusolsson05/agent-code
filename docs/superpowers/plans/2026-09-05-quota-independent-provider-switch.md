# Quota-Independent Provider Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make single and bulk provider switches complete without any live turn on the source provider, so agents can leave an exhausted Claude or Codex subscription window, while every lossy step is deterministic, reported, and handled by the target's own native compaction.

**Architecture:** The parser gains an isolated shrink ladder and a planner option that never returns a source-turn outcome; the main-process transaction defaults to that option and adds an arrival compaction step for Claude targets; the usage service derives a structural exhaustion signal; the bulk modal reads it, asks once, and labels strategies. The existing source-side `/compact` path is preserved as an explicit opt-in with two hazard checks added.

**Tech Stack:** TypeScript, Vitest 4 (parser `core`/`corpus` projects, app `unit`/`system`/`renderer` projects), Electron IPC, git submodules for `agent-transcript-parser` and `codex-headless`.

**Spec:** `docs/superpowers/specs/2026-09-05-quota-independent-provider-switch-design.md`
**Decomposition:** `docs/decomposition/quota-independent-provider-switch.md` (Stage 0 must be approved and complete before Task 2 starts)
**Issues:** #821 (feature, `Fixes`), #820 (hazard, `Fixes`), agent-transcript-parser#24, codex-headless#46

## Global Constraints

- Default `contextPolicy.allowSourceTurns` is `false`; the transaction must never call `runtime.compactSource` under that default.
- No custom summarization prompt is introduced. The only summarizers are the providers' own `/compact` paths.
- Character budget stays `tokens × effectivePercent × (1 − 0.1) × 2.5` from `budgetCharactersForContextTokens`; Codex projections must remain under Codex's 90 percent auto-compact limit, which the 0.9 reserve on a 95 percent effective window already guarantees (85.5 percent).
- Parser fixtures come from `testing/corpus/extract-observed-sequences.mts` output only. No transcript literals invented in tests; a synthesized fixture must be labeled in its manifest `normalization`.
- Wait loops keep scalars, never a `ConversationDocument`, across an `await` (#720 discipline).
- Commit subjects use Conventional Commits with a subsystem scope; every commit body that touches behavior explains why.
- Files owned by A5/A6 (#808–811, #813–814), #701, and the operator toolkit (`src/main/control`, `src/main/externalControlMcp`) are not modified. `src/renderer/src/workspace/hook/index.ts` changes only to pass new parameters.
- Do not merge. Open the PRs and stop.

## File map

| Repo | File | Responsibility |
|---|---|---|
| parser | `src/operations/estimate.ts` (new) | Character estimators and user-boundary predicate shared by budget and shrink |
| parser | `src/operations/shrink.ts` (new) | The shrink ladder and its report; only consumer is the planner |
| parser | `src/operations/contextBudget.ts` | `allowSourceTurns` option, `raw-history` and `shrunk` outcomes |
| parser | `src/operations/compaction.ts` | `rejected` availability, rate-limit prefixes, `findApiErrorAfterLine` |
| parser | `src/claude/conversation/decode.ts` | API-error assistant records become opaque |
| parser | `testing/engine/shrink.test.ts` (new), `testing/engine/contextBudget.test.ts`, `testing/engine/compaction.test.ts` (new), `testing/engine/nativeResumeProjection.test.ts` | Tests against Stage 0 fixtures |
| parser | `fixtures/evidence/observed-sequences/<new cases>` | Stage 0 corpus |
| codex-headless | `src/proxy/responsesProxy.ts`, `src/proxy/CodexResponsesAdapter.ts`, `src/channels/types.ts`, `src/channels/SemanticChannel.ts` | HTTP-failure classification incl. `usage_limit_reached` |
| codex-headless | `src/proxy/CodexResponsesAdapter.httpFailure.test.ts` (new) | Recorded-style test |
| app | `src/main/providerSwitch/switchProvider.ts` | Policy, strategy, `shrinking` progress |
| app | `src/main/providerSwitch/compactBeforeSwitch.ts` | Hazard checks; wait loop generalized to any session |
| app | `src/main/providerSwitch/compactOnArrival.ts` (new) | Arrival compaction for Claude targets |
| app | `src/main/ipc/provider.ts` | Policy pass-through, batch confirmation flag, new IPC |
| app | `src/preload/api/provider.ts`, `src/preload/index.d.ts` | `compactAfterSwitch`, `contextPolicy` types |
| app | `src/shared/types/usage.ts`, `src/main/usage/claudeUsage.ts`, `src/main/usage/codexUsage.ts`, `src/main/usage/normalize.ts` | Row `scope` |
| app | `src/shared/usage/exhaustion.ts` (new), `src/shared/usage/exhaustion.test.ts` (new) | Pure exhaustion derivation |
| app | `src/renderer/src/session-runtime/state.ts`, `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` | `limitHit` runtime field |
| app | `src/renderer/src/workspace/hook/actions/providerSwitchCore.ts`, `bulkProviderSwitch.ts`, `hook/index.ts` | Policy plumbing, guard, strategy tally |
| app | `src/renderer/src/features/workspace/ui/BulkProviderSwitchModal.tsx` | Banner, checkboxes, one confirmation, strategy summary |
| app | `docs/design/provider-switching.md` | Updated contract |

---

### Task 0: Evidence corpus (decomposition Stage 0)

**Files:**
- Create: `packages/agent-transcript-parser/fixtures/evidence/observed-sequences/codex-sequence-compacted-once/{manifest.json,source.jsonl}`
- Create: `.../codex-sequence-compacted-multi/`, `.../codex-sequence-rate-limit-snapshot/`, `.../claude-sequence-rate-limit/`, `.../claude-sequence-oversized/`
- Create: `docs/decomposition/evidence/provider-switch/census.md`
- Modify: `packages/agent-transcript-parser/testing/corpus/extractObservedSequences.ts` (add the five relationships)

**Interfaces:**
- Produces: five fixture directories loadable by `readFile(new URL('source.jsonl', directory))` exactly like the existing sequence cases, each with `manifest.caseId` equal to the directory name and `proves: ['wire-shape', 'classification']`.

- [ ] **Step 1: Add the five relationships to the sequence extractor**

Open `packages/agent-transcript-parser/testing/corpus/extractObservedSequences.ts` and locate the relationship table that defines `codex-sequence-compaction`. Add, in the same shape:

```ts
{
  caseId: 'codex-sequence-compacted-once',
  provider: 'codex',
  // A rollout with exactly one `compacted` record: session_meta, every
  // response_item before it, the compacted record, and every response_item
  // after it. Kept whole because the shrink ladder must see real pre- and
  // post-compaction proportions, not a two-record reduction.
  select: file => countRecords(file, r => r.type === 'compacted') === 1,
  keep: r => r.type === 'session_meta' || r.type === 'response_item' || r.type === 'compacted' || r.type === 'turn_context',
},
{
  caseId: 'codex-sequence-compacted-multi',
  provider: 'codex',
  select: file => countRecords(file, r => r.type === 'compacted') >= 3,
  keep: r => r.type === 'session_meta' || r.type === 'response_item' || r.type === 'compacted' || r.type === 'turn_context',
},
{
  caseId: 'codex-sequence-rate-limit-snapshot',
  provider: 'codex',
  select: file => file.some(r => r.type === 'event_msg' && r.payload?.type === 'token_count' && r.payload?.rate_limits?.rate_limit_reached_type != null),
  keep: r => r.type === 'session_meta' || (r.type === 'event_msg' && r.payload?.type === 'token_count'),
},
{
  caseId: 'claude-sequence-rate-limit',
  provider: 'claude',
  select: file => file.some(r => r.type === 'assistant' && r.isApiErrorMessage === true && r.error === 'rate_limit'),
  // The user prompt before the error and the error itself, plus any
  // compact_boundary/isCompactSummary that follows: this is the #820 evidence.
  keep: r => r.type === 'user' || r.type === 'assistant' || r.type === 'system',
},
{
  caseId: 'claude-sequence-oversized',
  provider: 'claude',
  select: file => estimateSemanticCharacters(file) > 581_400,
  keep: r => r.type === 'user' || r.type === 'assistant' || r.type === 'system',
},
```

`countRecords` and `estimateSemanticCharacters` are small helpers in the same file: the first counts records matching a predicate; the second sums the length of `message.content` text blocks and `tool_result` content strings. If the extractor's existing helpers already cover these, reuse them.

- [ ] **Step 2: Run the extractor against the local stores**

Run from `packages/agent-transcript-parser`:

```bash
npx tsx testing/corpus/extract-observed-sequences.mts --out fixtures/evidence/observed-sequences
```

Expected: five new directories. If `codex-sequence-rate-limit-snapshot` finds no candidate (no local rollout has `rate_limit_reached_type` set), leave it out and record that in the census; Task 5 captures one live.

- [ ] **Step 3: Review redaction by hand**

For each new `source.jsonl`, run:

```bash
grep -c "/Users/" fixtures/evidence/observed-sequences/<case>/source.jsonl
```

Expected: `0` for every case. Also confirm no API key patterns (`sk-`, `Bearer`) survive.

- [ ] **Step 4: Run the corpus and manifest checks**

```bash
npm run test:corpus
```

Expected: PASS, including the manifest schema validation for the new cases.

- [ ] **Step 5: Write the census**

Create `docs/decomposition/evidence/provider-switch/census.md` with a table per fixture: bytes by entry kind after decoding (`message/user`, `message/assistant`, `reasoning`, `tool-call input`, `tool-result output`, `compaction`), total characters per `estimateConversationCharacters`, and the ratio of tool-result bytes to total. Use this one-off script (do not commit it):

```ts
import { readFile } from 'node:fs/promises'
import { classifyClaudeDocument, classifyCodexDocument, decodeClaudeConversation, decodeCodexConversation, decodeJsonl } from '../src/index.js'
const text = await readFile(process.argv[2], 'utf8')
const doc = decodeJsonl(text)
const conversation = process.argv[3] === 'claude'
  ? decodeClaudeConversation(classifyClaudeDocument(doc).records)
  : decodeCodexConversation(classifyCodexDocument(doc).records)
const bytes: Record<string, number> = {}
for (const entry of conversation.entries) {
  const key = entry.kind === 'message' ? `message/${entry.role}` : entry.kind
  const size = entry.kind === 'message' ? JSON.stringify(entry.content).length
    : entry.kind === 'reasoning' ? entry.text.length
    : entry.kind === 'tool-call' ? JSON.stringify(entry.input ?? '').length
    : entry.kind === 'tool-result' ? JSON.stringify(entry.output ?? '').length
    : entry.kind === 'compaction' ? entry.summary.length : 0
  bytes[key] = (bytes[key] ?? 0) + size
}
console.log(JSON.stringify(bytes, null, 2))
```

Record in the census whether any of the five local Claude rate-limit transcripts has a `compact_boundary` after the error (the #820 question), with the answer yes or no per file (file names redacted to an index).

- [ ] **Step 6: Commit (parser submodule)**

```bash
cd packages/agent-transcript-parser
git checkout -b feat/quota-independent-context-planning
git add fixtures/evidence/observed-sequences testing/corpus/extractObservedSequences.ts
git commit -m "test(corpus): record compacted, rate-limited and oversized transcript sequences

Refs Juliusolsson05/agent-transcript-parser#24"
```

And in the app worktree:

```bash
git add docs/decomposition/evidence/provider-switch/census.md
git commit -m "docs(provider-switch): record transcript census for the shrink ladder

Refs #821"
```

**Stop here and present the census to the user. Stage 0 is the approval gate for the ladder thresholds in Task 2.**

---

### Task 1: Parser hazard fixes (#820, Stage 1)

**Files:**
- Modify: `packages/agent-transcript-parser/src/operations/compaction.ts`
- Modify: `packages/agent-transcript-parser/src/claude/conversation/decode.ts:56-60`
- Create: `packages/agent-transcript-parser/testing/engine/compaction.test.ts`

**Interfaces:**
- Produces: `CompactionAvailability` gains `'rejected'`; `CLAUDE_RATE_LIMIT_PREFIXES: readonly string[]`; `findApiErrorAfterLine(conversation, baselineLine): ConversationOpaque | null`; Claude decode emits `{ kind: 'opaque', nativeType: 'api_error' }` for `isApiErrorMessage: true` assistant records.

- [ ] **Step 1: Write the failing tests**

```ts
// testing/engine/compaction.test.ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  classifyClaudeDocument,
  decodeClaudeConversation,
  decodeJsonl,
  describeLatestCompaction,
  findApiErrorAfterLine,
} from '../../src/index.js'

const fixture = new URL('../../fixtures/evidence/observed-sequences/claude-sequence-rate-limit/source.jsonl', import.meta.url)

async function loadRateLimitConversation() {
  const raw = decodeJsonl(await readFile(fixture, 'utf8'))
  return decodeClaudeConversation(classifyClaudeDocument(raw).records)
}

describe('rate-limit records', () => {
  it('decodes a Claude rate-limit API error as an opaque entry, never as assistant text', async () => {
    const conversation = await loadRateLimitConversation()
    const errors = conversation.entries.filter(entry => entry.kind === 'opaque' && entry.nativeType === 'api_error')
    expect(errors.length).toBeGreaterThan(0)
    const assistantText = conversation.entries
      .filter(entry => entry.kind === 'message' && entry.role === 'assistant')
      .flatMap(entry => entry.kind === 'message' ? entry.content : [])
      .filter(content => content.kind === 'text')
      .map(content => content.kind === 'text' ? content.text : '')
    expect(assistantText.some(text => text.startsWith("You've hit your"))).toBe(false)
  })

  it('reports the first API error after a baseline line', async () => {
    const conversation = await loadRateLimitConversation()
    const found = findApiErrorAfterLine(conversation, -1)
    expect(found?.kind).toBe('opaque')
    expect(findApiErrorAfterLine(conversation, found!.source.line)).toBeNull()
  })

  it('rejects a compaction carrier whose text is a rate-limit message', async () => {
    const conversation = await loadRateLimitConversation()
    const error = findApiErrorAfterLine(conversation, -1)!
    const text = String((error.source.raw.message as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '')
    // Synthesized from the real record's text: a boundary + carrier pair that
    // Claude would write if it accepted this text as its summary (see #820).
    const synthetic = {
      ...conversation,
      entries: [{
        kind: 'compaction' as const,
        summary: text,
        summarySource: 'carrier' as const,
        timestamp: error.timestamp,
        source: { ...error.source, line: error.source.line + 1 },
      }],
    }
    expect(describeLatestCompaction(synthetic)?.availability).toBe('rejected')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/agent-transcript-parser && npx vitest run testing/engine/compaction.test.ts`
Expected: FAIL — `findApiErrorAfterLine` is not exported; the first test finds zero opaque `api_error` entries.

- [ ] **Step 3: Implement in `compaction.ts`**

```ts
export type CompactionAvailability = 'portable' | 'native-only' | 'incomplete' | 'rejected'

// WHY these prefixes are a parser constant: Claude Code writes its rate-limit
// message as an ordinary assistant record whose text starts with one of these
// (services/rateLimitMessages.ts RATE_LIMIT_ERROR_PREFIXES). Its own
// compaction only rejects summaries starting with "API Error", so a limit hit
// during /compact can plausibly persist this text as the summary. Any host
// that accepted such a carrier would switch with the history destroyed (#820).
export const CLAUDE_RATE_LIMIT_PREFIXES = [
  "You've hit your",
  "You've used",
  "You're now using extra usage",
  "You're close to",
  "You're out of extra usage",
] as const

export function isRateLimitText(text: string): boolean {
  const trimmed = text.trimStart()
  return CLAUDE_RATE_LIMIT_PREFIXES.some(prefix => trimmed.startsWith(prefix))
}

export function findApiErrorAfterLine(
  conversation: ConversationDocument,
  baselineLine: number,
): ConversationOpaque | null {
  for (const entry of conversation.entries) {
    if (entry.kind !== 'opaque' || entry.nativeType !== 'api_error') continue
    if (entry.source.line > baselineLine) return entry
  }
  return null
}
```

In `compactionAvailability`, before the existing placeholder check:

```ts
  if (isRateLimitText(entry.summary)) return 'rejected'
```

`conversationAfterLatestPortableCompaction` already returns the conversation unchanged for anything not `portable`, so `rejected` needs no further handling there. Add `ConversationOpaque` to the imports from `../conversation/types.js`.

- [ ] **Step 4: Implement in `claude/conversation/decode.ts`**

At the top of the `user-message || assistant-message` branch (line 56), before computing `role`:

```ts
      if (record.family === 'assistant-message' && record.raw.isApiErrorMessage === true) {
        // WHY an API error is opaque rather than an assistant message: Claude
        // persists "You've hit your session limit…" as an assistant-shaped
        // record so the TUI can render it. It is not model output. Projecting
        // it would carry a provider's billing message into another provider's
        // history as if the model had said it, and a rate-limit text would
        // become indistinguishable from a summary (#820).
        entries.push({ kind: 'opaque', nativeType: 'api_error', timestamp, source })
        continue
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/agent-transcript-parser && npx vitest run testing/engine/compaction.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Run the parser suite once**

Run: `cd packages/agent-transcript-parser && npm test`
Expected: PASS. If `nativeResumeProjection.test.ts` counted assistant entries from a fixture that contains an api error, update its expectation with a comment citing this task.

- [ ] **Step 7: Commit**

```bash
git add src/operations/compaction.ts src/claude/conversation/decode.ts testing/engine/compaction.test.ts
git commit -m "fix(compaction): reject rate-limit text as a summary and keep API errors out of history

A Claude rate-limit message is persisted as an assistant record and is not
rejected by Claude's own compaction guard. Treat such a carrier as rejected
and decode API-error records as opaque so no host can project them.

Refs Juliusolsson05/agent-transcript-parser#24, Juliusolsson05/agent-code#820"
```

---

### Task 2: Parser shrink ladder and planner option (Stage 2)

**Files:**
- Create: `packages/agent-transcript-parser/src/operations/estimate.ts`
- Create: `packages/agent-transcript-parser/src/operations/shrink.ts`
- Modify: `packages/agent-transcript-parser/src/operations/contextBudget.ts`
- Modify: `packages/agent-transcript-parser/src/index.ts` (export `./operations/shrink.js`)
- Create: `packages/agent-transcript-parser/testing/engine/shrink.test.ts`
- Modify: `packages/agent-transcript-parser/testing/engine/contextBudget.test.ts`
- Modify: `packages/agent-transcript-parser/testing/engine/nativeResumeProjection.test.ts`

**Interfaces:**
- Consumes: `describeLatestCompaction`, `conversationAfterLatestPortableCompaction`, `compactionAvailability` semantics from Task 1.
- Produces:

```ts
// estimate.ts
export function estimateEntryCharacters(entry: ConversationEntry): number
export function estimateConversationCharacters(conversation: ConversationDocument): number
export function isSafeResumeBoundary(entry: ConversationEntry): boolean

// shrink.ts
export interface ShrinkOptions {
  keepRecentTurns?: number   // default 3
  maxInputChars?: number     // default 8_000
  maxIndexedPrompts?: number // default 40
  promptIndexChars?: number  // default 200
}
export interface ShrinkReport {
  strippedCompactions: number
  clearedResults: number
  clearedChars: number
  trimmedInputs: number
  trimmedChars: number
  droppedEntries: number
  droppedTurns: number
  promptIndexChars: number
  estimatedCharactersBefore: number
  estimatedCharactersAfter: number
  budgetCharacters: number
}
export interface ShrinkResult { conversation: ConversationDocument; report: ShrinkReport }
export class ConversationUnfittableError extends Error { readonly report: ShrinkReport }
export function stripNativeOnlyCompactions(conversation): { conversation: ConversationDocument; stripped: number }
export function clearToolResults(conversation, budgetCharacters, options?): { conversation; cleared: number; clearedChars: number }
export function trimToolInputs(conversation, budgetCharacters, options?): { conversation; trimmed: number; trimmedChars: number }
export function dropOldestTurns(conversation, budgetCharacters, options?): { conversation; droppedEntries: number; droppedTurns: number; promptIndexChars: number; stillExceedsBudget: boolean }
export function shrinkConversationToBudget(conversation, budgetCharacters, options?): ShrinkResult

// contextBudget.ts
export interface PlanConversationContextOptions { allowSourceTurns?: boolean; shrink?: ShrinkOptions }
export type ConversationContextPlan = /* existing four */
  | { kind: 'raw-history'; conversation; estimatedCharacters; budgetCharacters; strippedCompactions: number }
  | { kind: 'shrunk'; conversation; estimatedCharacters; budgetCharacters; report: ShrinkReport }
export function planConversationContext(conversation, targetProvider, budgetCharacters, options?: PlanConversationContextOptions): ConversationContextPlan
```

- [ ] **Step 1: Extract the estimators**

Move `estimateEntryCharacters`, `estimateConversationCharacters`, `printableLength`, `isSafeResumeBoundary`, `nextSafeBoundary`, `lastSafeBoundary` from `contextBudget.ts` into `estimate.ts` unchanged, and re-export `estimateConversationCharacters` from `contextBudget.ts` so the public surface is stable:

```ts
export { estimateConversationCharacters } from './estimate.js'
```

Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 2: Write the failing shrink tests against real fixtures**

```ts
// testing/engine/shrink.test.ts
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  classifyClaudeDocument, classifyCodexDocument,
  decodeClaudeConversation, decodeCodexConversation, decodeJsonl,
  estimateConversationCharacters,
  shrinkConversationToBudget, stripNativeOnlyCompactions, clearToolResults, dropOldestTurns,
  ConversationUnfittableError,
} from '../../src/index.js'

const sequences = new URL('../../fixtures/evidence/observed-sequences/', import.meta.url)
async function codex(caseId: string) {
  const raw = decodeJsonl(await readFile(new URL(`${caseId}/source.jsonl`, sequences), 'utf8'))
  return decodeCodexConversation(classifyCodexDocument(raw).records)
}
async function claude(caseId: string) {
  const raw = decodeJsonl(await readFile(new URL(`${caseId}/source.jsonl`, sequences), 'utf8'))
  return decodeClaudeConversation(classifyClaudeDocument(raw).records)
}

describe('stripNativeOnlyCompactions', () => {
  it('drops every encrypted Codex compaction and keeps the raw records around it', async () => {
    const conversation = await codex('codex-sequence-compacted-multi')
    const encrypted = conversation.entries.filter(e => e.kind === 'compaction').length
    expect(encrypted).toBeGreaterThanOrEqual(3)
    const { conversation: stripped, stripped: count } = stripNativeOnlyCompactions(conversation)
    expect(count).toBe(encrypted)
    expect(stripped.entries.some(e => e.kind === 'compaction')).toBe(false)
    expect(stripped.entries.filter(e => e.kind === 'message').length)
      .toBe(conversation.entries.filter(e => e.kind === 'message').length)
  })
})

describe('clearToolResults', () => {
  it('clears oldest results first and never touches the last three user turns', async () => {
    const conversation = await claude('claude-sequence-oversized')
    const before = estimateConversationCharacters(conversation)
    const { conversation: cleared, cleared: count, clearedChars } = clearToolResults(conversation, Math.floor(before / 2), { keepRecentTurns: 3 })
    expect(count).toBeGreaterThan(0)
    expect(clearedChars).toBeGreaterThan(0)
    // Every tool call keeps its input intact.
    const inputsBefore = conversation.entries.filter(e => e.kind === 'tool-call').map(e => JSON.stringify(e.kind === 'tool-call' ? e.input : null))
    const inputsAfter = cleared.entries.filter(e => e.kind === 'tool-call').map(e => JSON.stringify(e.kind === 'tool-call' ? e.input : null))
    expect(inputsAfter).toEqual(inputsBefore)
    // Results inside the last three user turns are untouched.
    const userIndexes = cleared.entries.map((e, i) => e.kind === 'message' && e.role === 'user' ? i : -1).filter(i => i >= 0)
    const protectedFrom = userIndexes.at(-3) ?? 0
    for (let i = protectedFrom; i < cleared.entries.length; i += 1) {
      const entry = cleared.entries[i]!
      if (entry.kind === 'tool-result') expect(entry.output).toEqual(conversation.entries[i]!.kind === 'tool-result' ? (conversation.entries[i] as typeof entry).output : entry.output)
    }
  })
})

describe('dropOldestTurns', () => {
  it('drops complete user turns from the front and indexes their prompts in the marker', async () => {
    const conversation = await claude('claude-sequence-oversized')
    const before = estimateConversationCharacters(conversation)
    const result = dropOldestTurns(conversation, Math.floor(before / 4))
    expect(result.droppedTurns).toBeGreaterThan(0)
    const marker = result.conversation.entries[0]!
    expect(marker.kind).toBe('compaction')
    expect(marker.kind === 'compaction' ? marker.summarySource : null).toBe('synthetic')
    expect(marker.kind === 'compaction' ? marker.summary : '').toContain('earlier prompts')
    expect(result.conversation.entries[1]?.kind === 'message' && result.conversation.entries[1].role).toBe('user')
  })
})

describe('shrinkConversationToBudget', () => {
  it('reports each rung it used and lands under budget', async () => {
    const conversation = await claude('claude-sequence-oversized')
    const budget = 581_400
    const { conversation: shrunk, report } = shrinkConversationToBudget(conversation, budget)
    expect(estimateConversationCharacters(shrunk)).toBeLessThanOrEqual(budget)
    expect(report.estimatedCharactersAfter).toBeLessThanOrEqual(budget)
    expect(report.estimatedCharactersBefore).toBeGreaterThan(budget)
    expect(report.clearedResults + report.droppedEntries).toBeGreaterThan(0)
  })

  it('throws instead of emitting a fragment when the last turn alone exceeds the budget', async () => {
    const conversation = await claude('claude-sequence-oversized')
    expect(() => shrinkConversationToBudget(conversation, 200)).toThrow(ConversationUnfittableError)
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run testing/engine/shrink.test.ts`
Expected: FAIL — module `./operations/shrink.js` does not exist.

- [ ] **Step 4: Implement `shrink.ts`**

```ts
import type {
  ConversationCompaction, ConversationDocument, ConversationEntry, ConversationToolResult,
} from '../conversation/types.js'
import { compactionAvailability } from './compaction.js'
import { estimateConversationCharacters, estimateEntryCharacters, isSafeResumeBoundary } from './estimate.js'

// See docs/superpowers/specs/2026-09-05-quota-independent-provider-switch-design.md
// §"Shrink ladder". This module is the isolated hard part of quota-independent
// switching: it is the ONLY place that decides what a transcript loses when it
// must fit a smaller window without any model call. It knows entry kinds and
// character budgets. It never names a provider. Its only consumer is
// planConversationContext; projectors and hosts must not import it.

export interface ShrinkOptions {
  keepRecentTurns?: number
  maxInputChars?: number
  maxIndexedPrompts?: number
  promptIndexChars?: number
}

export interface ShrinkReport {
  strippedCompactions: number
  clearedResults: number
  clearedChars: number
  trimmedInputs: number
  trimmedChars: number
  droppedEntries: number
  droppedTurns: number
  promptIndexChars: number
  estimatedCharactersBefore: number
  estimatedCharactersAfter: number
  budgetCharacters: number
}

export interface ShrinkResult {
  conversation: ConversationDocument
  report: ShrinkReport
}

export class ConversationUnfittableError extends Error {
  readonly report: ShrinkReport
  constructor(report: ShrinkReport) {
    super(`Conversation cannot fit the target budget of ${report.budgetCharacters} characters: the final complete turn alone is ${report.estimatedCharactersAfter} characters.`)
    this.name = 'ConversationUnfittableError'
    this.report = report
  }
}

const DEFAULTS: Required<ShrinkOptions> = {
  // WHY three: the census (docs/decomposition/evidence/provider-switch/census.md)
  // is the source of truth for this value; three complete user turns is the
  // smallest window that still contains "what I was just doing" for the
  // sessions measured there. Replace with the census figure in Task 0's PR.
  keepRecentTurns: 3,
  maxInputChars: 8_000,
  maxIndexedPrompts: 40,
  promptIndexChars: 200,
}

export function stripNativeOnlyCompactions(
  conversation: ConversationDocument,
): { conversation: ConversationDocument; stripped: number } {
  // WHY only native-only and rejected/incomplete entries are removed: a
  // portable (plaintext) or synthetic compaction is real content the target
  // can read. An encrypted or placeholder one carries nothing a foreign target
  // can use, while the raw records it summarized are still present.
  const entries = conversation.entries.filter(entry => (
    entry.kind !== 'compaction' || compactionAvailability(entry) === 'portable'
  ))
  return {
    conversation: entries.length === conversation.entries.length ? conversation : { ...conversation, entries },
    stripped: conversation.entries.length - entries.length,
  }
}

function userTurnStarts(entries: readonly ConversationEntry[]): number[] {
  const starts: number[] = []
  entries.forEach((entry, index) => {
    if (entry.kind === 'message' && entry.role === 'user') starts.push(index)
  })
  return starts
}

function protectedFromIndex(entries: readonly ConversationEntry[], keepRecentTurns: number): number {
  const starts = userTurnStarts(entries)
  if (keepRecentTurns <= 0 || starts.length === 0) return entries.length
  return starts[Math.max(0, starts.length - keepRecentTurns)] ?? entries.length
}

function clearedPlaceholder(chars: number): string {
  return `[tool output cleared during provider switch: ${chars} characters]`
}

export function clearToolResults(
  conversation: ConversationDocument,
  budgetCharacters: number,
  options: ShrinkOptions = {},
): { conversation: ConversationDocument; cleared: number; clearedChars: number } {
  const keepRecentTurns = options.keepRecentTurns ?? DEFAULTS.keepRecentTurns
  const limit = protectedFromIndex(conversation.entries, keepRecentTurns)
  let total = estimateConversationCharacters(conversation)
  if (total <= budgetCharacters) return { conversation, cleared: 0, clearedChars: 0 }
  const entries = [...conversation.entries]
  let cleared = 0
  let clearedChars = 0
  for (let index = 0; index < limit && total > budgetCharacters; index += 1) {
    const entry = entries[index]!
    if (entry.kind !== 'tool-result') continue
    const before = estimateEntryCharacters(entry)
    const placeholder = clearedPlaceholder(before)
    if (before <= placeholder.length) continue
    const replaced: ConversationToolResult = { ...entry, output: placeholder }
    entries[index] = replaced
    const after = estimateEntryCharacters(replaced)
    total -= before - after
    cleared += 1
    clearedChars += before - after
  }
  return { conversation: cleared === 0 ? conversation : { ...conversation, entries }, cleared, clearedChars }
}

export function trimToolInputs(
  conversation: ConversationDocument,
  budgetCharacters: number,
  options: ShrinkOptions = {},
): { conversation: ConversationDocument; trimmed: number; trimmedChars: number } {
  const keepRecentTurns = options.keepRecentTurns ?? DEFAULTS.keepRecentTurns
  const maxInputChars = options.maxInputChars ?? DEFAULTS.maxInputChars
  const limit = protectedFromIndex(conversation.entries, keepRecentTurns)
  let total = estimateConversationCharacters(conversation)
  if (total <= budgetCharacters) return { conversation, trimmed: 0, trimmedChars: 0 }
  const entries = [...conversation.entries]
  let trimmed = 0
  let trimmedChars = 0
  for (let index = 0; index < limit && total > budgetCharacters; index += 1) {
    const entry = entries[index]!
    if (entry.kind !== 'tool-call') continue
    const serialized = typeof entry.input === 'string' ? entry.input : JSON.stringify(entry.input ?? null)
    if (serialized.length <= maxInputChars) continue
    const before = estimateEntryCharacters(entry)
    const replaced = {
      ...entry,
      input: `${serialized.slice(0, maxInputChars)}\n[tool input trimmed during provider switch: ${serialized.length - maxInputChars} characters omitted]`,
    }
    entries[index] = replaced
    const after = estimateEntryCharacters(replaced)
    total -= before - after
    trimmed += 1
    trimmedChars += before - after
  }
  return { conversation: trimmed === 0 ? conversation : { ...conversation, entries }, trimmed, trimmedChars }
}

function promptText(entry: ConversationEntry): string {
  if (entry.kind !== 'message') return ''
  return entry.content.filter(c => c.kind === 'text').map(c => c.kind === 'text' ? c.text : '').join(' ').replace(/\s+/g, ' ').trim()
}

export function dropOldestTurns(
  conversation: ConversationDocument,
  budgetCharacters: number,
  options: ShrinkOptions = {},
): { conversation: ConversationDocument; droppedEntries: number; droppedTurns: number; promptIndexChars: number; stillExceedsBudget: boolean } {
  const maxIndexedPrompts = options.maxIndexedPrompts ?? DEFAULTS.maxIndexedPrompts
  const promptIndexChars = options.promptIndexChars ?? DEFAULTS.promptIndexChars
  const costs = conversation.entries.map(estimateEntryCharacters)
  const total = costs.reduce((a, b) => a + b, 0)
  if (total <= budgetCharacters) {
    return { conversation, droppedEntries: 0, droppedTurns: 0, promptIndexChars: 0, stillExceedsBudget: false }
  }
  // Walk backward accumulating complete turns; the first boundary at which the
  // suffix no longer fits is excluded. Mirrors fitConversationToCharacterBudget.
  let suffix = 0
  let startIndex = conversation.entries.length
  for (let index = conversation.entries.length - 1; index >= 0; index -= 1) {
    suffix += costs[index] ?? 0
    const entry = conversation.entries[index]!
    if (!isSafeResumeBoundary(entry)) continue
    if (suffix <= budgetCharacters) { startIndex = index; continue }
    break
  }
  if (startIndex >= conversation.entries.length) {
    // Even the final complete turn does not fit. Keep it whole and let the
    // caller decide; never emit a fragment of a turn.
    const last = [...conversation.entries].reverse().findIndex(isSafeResumeBoundary)
    startIndex = last < 0 ? 0 : conversation.entries.length - 1 - last
  }
  if (startIndex <= 0) {
    return { conversation, droppedEntries: 0, droppedTurns: 0, promptIndexChars: 0, stillExceedsBudget: true }
  }
  const dropped = conversation.entries.slice(0, startIndex)
  const kept = conversation.entries.slice(startIndex)
  const previousSummary = [...dropped].reverse().find(
    (entry): entry is ConversationCompaction => entry.kind === 'compaction' && entry.summary.trim().length > 0,
  )
  const prompts = dropped
    .filter(entry => entry.kind === 'message' && entry.role === 'user')
    .map(promptText)
    .filter(text => text.length > 0)
  const shown = prompts.slice(-maxIndexedPrompts)
  const index = shown.map((text, i) => `${prompts.length - shown.length + i + 1}. ${text.slice(0, promptIndexChars)}`).join('\n')
  const summary = [
    previousSummary?.summary,
    `[Provider switch omitted ${dropped.length} earlier entries across ${prompts.length} user turns so the session fits the target model. The retained history begins at the next complete user turn. Earlier prompts, oldest first${prompts.length > shown.length ? ` (last ${shown.length} shown)` : ''}:\n${index}]`,
  ].filter(Boolean).join('\n\n')
  const marker: ConversationCompaction = {
    kind: 'compaction',
    summary,
    summarySource: 'synthetic',
    timestamp: kept[0]?.timestamp ?? dropped.at(-1)?.timestamp ?? null,
    source: dropped.at(-1)?.source ?? kept[0]!.source,
  }
  const entries = [marker, ...kept]
  const after = entries.reduce((sum, entry) => sum + estimateEntryCharacters(entry), 0)
  return {
    conversation: { ...conversation, entries },
    droppedEntries: dropped.length,
    droppedTurns: prompts.length,
    promptIndexChars: index.length,
    stillExceedsBudget: after > budgetCharacters,
  }
}

export function shrinkConversationToBudget(
  conversation: ConversationDocument,
  budgetCharacters: number,
  options: ShrinkOptions = {},
): ShrinkResult {
  const report: ShrinkReport = {
    strippedCompactions: 0, clearedResults: 0, clearedChars: 0, trimmedInputs: 0, trimmedChars: 0,
    droppedEntries: 0, droppedTurns: 0, promptIndexChars: 0,
    estimatedCharactersBefore: estimateConversationCharacters(conversation),
    estimatedCharactersAfter: 0,
    budgetCharacters,
  }
  // Rung 1: encrypted and placeholder compactions carry nothing for a foreign
  // target; the records they summarized are still here.
  const stripped = stripNativeOnlyCompactions(conversation)
  report.strippedCompactions = stripped.stripped
  let current = stripped.conversation
  // Rung 2: tool outputs are the bulk of coding sessions and the cheapest
  // thing to lose; the model's own words and every edit input survive.
  const cleared = clearToolResults(current, budgetCharacters, options)
  report.clearedResults = cleared.cleared
  report.clearedChars = cleared.clearedChars
  current = cleared.conversation
  // Rung 3: oversized inputs (whole-file writes) beyond a cap.
  const trimmed = trimToolInputs(current, budgetCharacters, options)
  report.trimmedInputs = trimmed.trimmed
  report.trimmedChars = trimmed.trimmedChars
  current = trimmed.conversation
  // Rung 4: drop whole oldest turns, indexing their prompts in the marker.
  const dropped = dropOldestTurns(current, budgetCharacters, options)
  report.droppedEntries = dropped.droppedEntries
  report.droppedTurns = dropped.droppedTurns
  report.promptIndexChars = dropped.promptIndexChars
  current = dropped.conversation
  report.estimatedCharactersAfter = estimateConversationCharacters(current)
  if (dropped.stillExceedsBudget || report.estimatedCharactersAfter > budgetCharacters) {
    throw new ConversationUnfittableError(report)
  }
  return { conversation: current, report }
}
```

Add `export * from './operations/shrink.js'` to `src/index.ts`.

- [ ] **Step 5: Run the shrink tests**

Run: `npx vitest run testing/engine/shrink.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing planner tests**

Append to `testing/engine/contextBudget.test.ts`:

```ts
describe('planConversationContext without source turns', () => {
  it('returns raw-history for a Codex session with encrypted compaction that fits a 1M Claude budget', async () => {
    const conversation = await codex('codex-sequence-compacted-once')
    const budget = budgetCharactersForContextTokens(1_000_000)
    const plan = planConversationContext(conversation, 'claude', budget, { allowSourceTurns: false })
    expect(plan.kind).toBe('raw-history')
    if (plan.kind !== 'raw-history') return
    expect(plan.strippedCompactions).toBe(1)
    expect(plan.conversation.entries.some(e => e.kind === 'compaction')).toBe(false)
  })

  it('returns shrunk with a report for an oversized Claude session targeting Codex', async () => {
    const conversation = await claude('claude-sequence-oversized')
    const budget = 581_400
    const plan = planConversationContext(conversation, 'codex', budget, { allowSourceTurns: false })
    expect(plan.kind).toBe('shrunk')
    if (plan.kind !== 'shrunk') return
    expect(plan.estimatedCharacters).toBeLessThanOrEqual(budget)
    expect(plan.report.budgetCharacters).toBe(budget)
  })

  it('keeps the existing outcomes when source turns are allowed', async () => {
    const conversation = await codex('codex-sequence-compacted-once')
    const plan = planConversationContext(conversation, 'claude', budgetCharactersForContextTokens(1_000_000))
    expect(plan.kind).toBe('requires-portable-handoff')
  })
})
```

Reuse the `codex`/`claude` fixture loaders from `shrink.test.ts` by moving them into `testing/engine/fixtureConversations.ts` and importing from both files.

- [ ] **Step 7: Implement the planner option**

In `contextBudget.ts`:

```ts
import { shrinkConversationToBudget, stripNativeOnlyCompactions } from './shrink.js'
import type { ShrinkOptions, ShrinkReport } from './shrink.js'

export interface PlanConversationContextOptions {
  /**
   * WHY this defaults to true: every existing caller relies on the four
   * original outcomes, two of which instruct the host to run a live turn on
   * the source. A host that cannot or will not spend source quota passes
   * false and receives only outcomes it can execute alone.
   */
  allowSourceTurns?: boolean
  shrink?: ShrinkOptions
}
```

Extend the `ConversationContextPlan` union with the two new members from the Interfaces block, then at the top of `planConversationContext`:

```ts
  if (options.allowSourceTurns === false) {
    return planWithoutSourceTurns(conversation, budgetCharacters, options.shrink)
  }
```

and:

```ts
function planWithoutSourceTurns(
  conversation: ConversationDocument,
  budgetCharacters: number,
  shrink: ShrinkOptions | undefined,
): ConversationContextPlan {
  const latest = describeLatestCompaction(conversation)
  // A portable summary already replaces everything before it; slice first so
  // stripping cannot resurrect records the source itself evicted.
  const sliced = conversationAfterLatestPortableCompaction(conversation)
  const stripped = stripNativeOnlyCompactions(sliced)
  const estimatedCharacters = estimateConversationCharacters(stripped.conversation)
  if (estimatedCharacters <= budgetCharacters) {
    if (stripped.stripped > 0) {
      return { kind: 'raw-history', conversation: stripped.conversation, estimatedCharacters, budgetCharacters, strippedCompactions: stripped.stripped }
    }
    return sliced === conversation
      ? { kind: 'ready', conversation, estimatedCharacters, budgetCharacters }
      : { kind: 'existing-compaction', conversation: sliced, estimatedCharacters, budgetCharacters, compactionSourceLine: latest!.entry.source.line }
  }
  const { conversation: shrunk, report } = shrinkConversationToBudget(stripped.conversation, budgetCharacters, shrink)
  return { kind: 'shrunk', conversation: shrunk, estimatedCharacters: report.estimatedCharactersAfter, budgetCharacters, report }
}
```

`planConversationContext`'s signature gains `options: PlanConversationContextOptions = {}` as the fourth parameter.

- [ ] **Step 8: Structural projection tests**

Append to `testing/engine/nativeResumeProjection.test.ts`:

```ts
it('projects a shrunk conversation into Codex and Claude native shapes without validation errors', async () => {
  const conversation = await claude('claude-sequence-oversized')
  const { conversation: shrunk } = shrinkConversationToBudget(conversation, 581_400)
  const codex = codexNativeResumeProjector.projectNativeResume(shrunk, {
    targetSessionId: '00000000-0000-4000-8000-000000000001', now: '2026-09-05T00:00:00.000Z', cwd: '/project',
    cliVersion: '0.153.4', modelProvider: 'openai', model: 'gpt-6-astra',
  })
  expect(codex.values.some(v => v.type === 'response_item' && (v.payload as { role?: string })?.role === 'developer')).toBe(true)
  expect(codex.report.changes.filter(c => c.kind === 'dropped' && c.code.includes('tool')).length).toBe(0)
  const claudeOut = claudeNativeResumeProjector.projectNativeResume(shrunk, {
    targetSessionId: '00000000-0000-4000-8000-000000000002', now: '2026-09-05T00:00:00.000Z', cwd: '/project',
    version: '2.1.261', model: 'claude-fable-5-1[1m]',
  })
  expect(claudeOut.values.some(v => v.type === 'system' && v.subtype === 'compact_boundary')).toBe(true)
  expect(claudeOut.values.some(v => (v as { isCompactSummary?: boolean }).isCompactSummary === true)).toBe(true)
})
```

Adjust the projector option names to the ones already used in that test file.

- [ ] **Step 9: Run the parser suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/operations/estimate.ts src/operations/shrink.ts src/operations/contextBudget.ts src/index.ts testing/engine
git commit -m "feat(operations): plan context without source turns through a deterministic shrink ladder

Hosts that cannot spend source quota pass allowSourceTurns:false and get
raw-history or shrunk instead of an instruction to run /compact on the
source. The ladder strips encrypted compactions, clears old tool outputs,
trims oversized inputs, then drops whole oldest turns with a prompt index;
it never emits a turn fragment.

Refs Juliusolsson05/agent-transcript-parser#24"
```

Open the parser PR (`feat/quota-independent-context-planning`), title
`feat(operations): quota-independent context planning with deterministic shrink`, body per conventions, `Fixes #24`. Do not merge.

---

### Task 3: codex-headless usage-limit classification (codex-headless#46, Stage 4 part)

**Files:**
- Modify: `packages/codex-headless/src/proxy/responsesProxy.ts` (`streamUpstreamResponse`, the `kind: 'response'` emit)
- Modify: `packages/codex-headless/src/proxy/CodexResponsesAdapter.ts` (new `response` branch, `response-chunk` and `response-end` early exits, `classifyHttpFailure`)
- Modify: `packages/codex-headless/src/channels/types.ts:492-520` (`SemanticApiErrorEvent`)
- Modify: `packages/codex-headless/src/channels/SemanticChannel.ts:706-725` (`publishApiError`)
- Create: `packages/codex-headless/src/proxy/CodexResponsesAdapter.httpFailure.test.ts`

**Interfaces:**
- Produces: `SemanticApiErrorEvent.errorType` gains `'usage_limit_reached' | 'rate_limited'`; new optional fields `resetsAt?: number` (unix seconds), `limitId?: string`, `limitName?: string`. The proxy `response` event gains `headers: Record<string, string>` containing only `x-codex-active-limit`, `retry-after`, and headers matching `/^x-.+-(primary|secondary)-(used-percent|reset-after-seconds|window-minutes)$/` or `/^x-.+-limit-name$/`.

- [ ] **Step 1: Write the failing recorded-style test**

```ts
// src/proxy/CodexResponsesAdapter.httpFailure.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createRecordedAdapterHarness } from './CodexResponsesAdapter.recorded.test.js' // reuse the harness factory the recorded test exports; if it is file-local, lift it into ./testing/adapterHarness.ts in this task

// Body shape from codex-rs/codex-api/src/api_bridge.rs (usage_limit_reached
// branch). Marked SOURCE-DERIVED: no local proxy dump contained a 429 at the
// time of writing; replace with a recorded body when one is captured.
const USAGE_LIMIT_BODY = JSON.stringify({
  error: {
    type: 'usage_limit_reached',
    message: "You've hit your usage limit. Try again later.",
    resets_at: 1788659183,
    plan_type: 'pro',
  },
})

describe('HTTP failures on /responses', () => {
  it('publishes usage_limit_reached with the active limit and reset time', () => {
    const { proxy, semantic } = createRecordedAdapterHarness()
    const published = vi.spyOn(semantic, 'publishApiError')
    proxy.emit('event', { kind: 'request', requestId: 'r1', path: '/v1/responses', endpoint: 'responses' })
    proxy.emit('event', {
      kind: 'response', requestId: 'r1', path: '/v1/responses', status: 429,
      headers: {
        'x-codex-active-limit': 'codex',
        'x-codex-primary-used-percent': '100',
        'x-codex-secondary-used-percent': '42.5',
        'x-codex-limit-name': 'Codex',
      },
    })
    proxy.emit('event', { kind: 'response-chunk', requestId: 'r1', path: '/v1/responses', size: USAGE_LIMIT_BODY.length, chunk: Buffer.from(USAGE_LIMIT_BODY) })
    proxy.emit('event', { kind: 'response-end', requestId: 'r1', path: '/v1/responses' })
    expect(published).toHaveBeenCalledWith(expect.objectContaining({
      errorType: 'usage_limit_reached',
      status: 429,
      resetsAt: 1788659183,
      limitId: 'codex',
      limitName: 'Codex',
    }))
  })

  it('classifies a generic 429 without the usage-limit type as rate_limited', () => {
    const { proxy, semantic } = createRecordedAdapterHarness()
    const published = vi.spyOn(semantic, 'publishApiError')
    proxy.emit('event', { kind: 'request', requestId: 'r2', path: '/v1/responses', endpoint: 'responses' })
    proxy.emit('event', { kind: 'response', requestId: 'r2', path: '/v1/responses', status: 429, headers: { 'retry-after': '20' } })
    proxy.emit('event', { kind: 'response-chunk', requestId: 'r2', path: '/v1/responses', size: 2, chunk: Buffer.from('{}') })
    proxy.emit('event', { kind: 'response-end', requestId: 'r2', path: '/v1/responses' })
    expect(published).toHaveBeenCalledWith(expect.objectContaining({ errorType: 'rate_limited', retryAfterMs: 20_000 }))
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/codex-headless && npx vitest run src/proxy/CodexResponsesAdapter.httpFailure.test.ts`
Expected: FAIL — no `publishApiError` call (the adapter ignores `kind: 'response'`).

- [ ] **Step 3: Extend the proxy event**

In `responsesProxy.ts` `streamUpstreamResponse`, replace the `this.emit('event', { kind: 'response', ... })` call with:

```ts
    this.emit('event', {
      kind: 'response',
      requestId,
      path: originalUrl,
      status: upstreamRes.status,
      // WHY only rate-limit headers travel on the event: the adapter must
      // classify a 429 body against the active limit pool, and the pool
      // identity lives in headers, not the body (codex-api/src/api_bridge.rs
      // reads x-codex-active-limit). Forwarding every header would put auth
      // and request ids into the semantic stream for no consumer.
      headers: pickRateLimitHeaders(upstreamRes.headers),
    })
```

and add:

```ts
const RATE_LIMIT_HEADER = /^x-.+-(?:primary|secondary)-(?:used-percent|reset-after-seconds|window-minutes)$|^x-.+-limit-name$/
export function pickRateLimitHeaders(headers: Headers): Record<string, string> {
  const picked: Record<string, string> = {}
  headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower === 'x-codex-active-limit' || lower === 'retry-after' || RATE_LIMIT_HEADER.test(lower)) {
      picked[lower] = value
    }
  })
  return picked
}
```

Add `headers?: Record<string, string>` to the proxy's `response` event type where the event union is declared.

- [ ] **Step 4: Handle HTTP failures in the adapter**

Add to the flow record type: `httpFailure: { status: number; headers: Record<string, string>; body: string } | null`, initialized `null` where flows are created. In `handleProxyEvent` add, before the `response-chunk` branch:

```ts
    if (kind === 'response') {
      const status = typeof ev.status === 'number' ? ev.status : 0
      const requestId = typeof ev.requestId === 'string' ? ev.requestId : ''
      const flow = this.findFlowByRequestId(requestId)
      if (!flow || status < 400) return
      // A non-2xx /responses reply is a JSON error document, not an SSE
      // stream. Buffer it whole and classify at response-end; the SSE frame
      // drain would otherwise see a body with no `data:` lines and publish
      // nothing, which is how usage limits used to vanish into a timeout.
      flow.httpFailure = {
        status,
        headers: isRecord(ev.headers) ? (ev.headers as Record<string, string>) : {},
        body: '',
      }
      return
    }
```

In the `response-chunk` branch, immediately after `flow.lastEventAt = Date.now()`:

```ts
      if (flow.httpFailure) {
        flow.httpFailure.body += chunkEv.chunk.toString('utf8')
        return
      }
```

In the `response-end` branch, immediately after `flow.lastEventAt = Date.now()`:

```ts
      if (flow.httpFailure) {
        const classified = classifyHttpFailure(flow.httpFailure)
        this.headless.semantic.publishApiError({
          turnId: flow.responseId,
          errorType: classified.errorType,
          message: classified.message,
          retryAfterMs: classified.retryAfterMs,
          status: flow.httpFailure.status,
          resetsAt: classified.resetsAt,
          limitId: classified.limitId,
          limitName: classified.limitName,
          source: 'proxy',
        })
        if (flow.turnOpened && flow.responseId) {
          this.headless.semantic.finishTurn({ turnId: flow.responseId, fullText: flow.fullText || undefined, source: 'proxy', confidence: 'fallback' })
        }
        if (this.activeFlowId === flow.flowId) this.activeFlowId = null
        this.publishRequestTerminal(flow, 'failed', 'response-error')
        this.flows.delete(flow.flowId)
        return
      }
```

And the classifier, next to `classifyResponseFailed`:

```ts
/** Port of codex-api/src/api_bridge.rs (usage_limit_reached) plus the
 *  generic 429 fallback. Runs on buffered non-2xx bodies only. */
function classifyHttpFailure(failure: { status: number; headers: Record<string, string>; body: string }): {
  errorType: SemanticApiErrorEvent['errorType']
  message: string
  retryAfterMs?: number
  resetsAt?: number
  limitId?: string
  limitName?: string
} {
  let parsed: Record<string, unknown> | null = null
  try { parsed = asRecord(JSON.parse(failure.body)) } catch { parsed = null }
  const error = parsed ? asRecord(parsed.error) : null
  const type = error ? stringField(error, 'type') ?? '' : ''
  const message = (error && stringField(error, 'message')) || `HTTP ${failure.status} from /responses`
  const retryAfterSeconds = Number(failure.headers['retry-after'])
  const retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : undefined
  if (failure.status === 429 && type === 'usage_limit_reached') {
    const limitId = failure.headers['x-codex-active-limit'] || 'codex'
    const resets = error ? error.resets_at : undefined
    return {
      errorType: 'usage_limit_reached',
      message,
      retryAfterMs,
      resetsAt: typeof resets === 'number' ? resets : undefined,
      limitId,
      limitName: failure.headers[`x-${limitId.replace(/_/g, '-')}-limit-name`] ?? failure.headers[`x-${limitId}-limit-name`],
    }
  }
  if (failure.status === 429) return { errorType: 'rate_limited', message, retryAfterMs }
  if (type === 'insufficient_quota') return { errorType: 'quota_exceeded', message }
  const sse = classifyResponseFailed(parsed ?? undefined)
  return { errorType: sse.errorType, message: sse.message, retryAfterMs: sse.retryAfterMs ?? retryAfterMs }
}
```

Extend `SemanticApiErrorEvent` in `channels/types.ts` with the two new `errorType` members and `resetsAt?: number; limitId?: string; limitName?: string`, and pass those three through `publishApiError` in `SemanticChannel.ts`.

- [ ] **Step 5: Run tests and typecheck**

Run: `cd packages/codex-headless && npx vitest run src/proxy/CodexResponsesAdapter.httpFailure.test.ts && npm run typecheck && npm run test:core`
Expected: PASS.

- [ ] **Step 6: Commit (codex-headless submodule)**

```bash
git checkout -b fix/usage-limit-classification
git add src/proxy src/channels
git commit -m "fix(proxy): classify usage_limit_reached and generic 429 replies as distinct api errors

Non-2xx /responses replies are JSON documents, not SSE; buffer and
classify them so an exhausted subscription window is observable
structurally with its active limit pool and reset time.

Fixes Juliusolsson05/codex-headless#46"
```

Open the codex-headless PR. Do not merge.

---

### Task 4: Host switch policy and strategy (Stage 3)

**Files:**
- Modify: `src/main/providerSwitch/switchProvider.ts`
- Modify: `src/main/providerSwitch/switchProvider.test.ts`
- Modify: `src/main/ipc/provider.ts`
- Modify: `src/preload/api/provider.ts`

**Interfaces:**
- Consumes: `planConversationContext(..., { allowSourceTurns: false })`, `ShrinkReport` from Task 2 (after the parser submodule pointer is bumped in this worktree; see Task 9 Step 1 for the bump order, which must happen before this task compiles).
- Produces:

```ts
export type SwitchContextPolicy = { allowSourceTurns: boolean; compactOnArrival: boolean }
export const DEFAULT_SWITCH_CONTEXT_POLICY: SwitchContextPolicy = { allowSourceTurns: false, compactOnArrival: false }
export type SwitchStrategy = 'native' | 'raw' | 'shrunk'
// SwitchProviderRequest gains: contextPolicy?: Partial<SwitchContextPolicy>; sourceCompactionConfirmed?: boolean
// SwitchProviderResult 'switched' gains: strategy: SwitchStrategy; shrinkSummary: string | null
// ProviderSwitchProgress.phase gains: 'shrinking'
export function describeShrink(report: ShrinkReport): string
```

- [ ] **Step 1: Write the failing tests**

Append to `switchProvider.test.ts`, using the existing `mocks` and a conversation decoded from the Stage 0 fixture instead of the inline literal (add a loader that reads `packages/agent-transcript-parser/fixtures/evidence/observed-sequences/codex-sequence-compacted-once/source.jsonl` through the real parser; the transcript engine is mocked, the parser is not):

```ts
describe('quota-independent policy', () => {
  it('never asks for a source turn by default when the Codex source has encrypted compaction', async () => {
    mocks.sourceRead.mockResolvedValue(await loadFixtureConversation('codex-sequence-compacted-once', 'codex'))
    mocks.targetProfile.mockResolvedValue({ model: 'claude-fable-5-1[1m]', budgetCharacters: 2_250_000 })
    mocks.targetProject.mockReturnValue(claudeProjection)
    mocks.targetWrite.mockResolvedValue('/claude/target.jsonl')
    mocks.targetSessionId.mockReturnValue('target-session')
    const compactSource = vi.fn()
    const result = await switchProvider(
      { sourceKind: 'codex', targetKind: 'claude', sourceProviderSessionId: 'src', cwd: '/project', sourceSessionId: 'local' },
      { compactSource },
    )
    expect(compactSource).not.toHaveBeenCalled()
    expect(result).toMatchObject({ kind: 'switched', strategy: 'raw', shrinkSummary: null })
    const projected = mocks.targetProject.mock.calls[0]![0]
    expect(projected.entries.some((e: { kind: string }) => e.kind === 'compaction')).toBe(false)
  })

  it('reports shrunk with a summary and a shrinking progress phase when the history exceeds the target', async () => {
    mocks.sourceRead.mockResolvedValue(await loadFixtureConversation('claude-sequence-oversized', 'claude'))
    mocks.targetProfile.mockResolvedValue({ model: 'gpt-6-astra', modelProvider: 'openai', budgetCharacters: 581_400 })
    mocks.targetProject.mockReturnValue(projection)
    mocks.targetWrite.mockResolvedValue('/codex/target.jsonl')
    mocks.targetSessionId.mockReturnValue('target-session')
    const onProgress = vi.fn()
    const result = await switchProvider(
      { sourceKind: 'claude', targetKind: 'codex', sourceProviderSessionId: 'src', cwd: '/project', sourceSessionId: 'local' },
      { onProgress },
    )
    expect(result).toMatchObject({ kind: 'switched', strategy: 'shrunk' })
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'shrinking' }))
    expect((result as { shrinkSummary: string }).shrinkSummary).toMatch(/cleared|dropped/)
  })

  it('still runs the opt-in source path when allowSourceTurns is true', async () => {
    mocks.sourceRead.mockResolvedValue(await loadFixtureConversation('codex-sequence-compacted-once', 'codex'))
    mocks.targetProfile.mockResolvedValue({ model: 'claude-fable-5-1[1m]', budgetCharacters: 2_250_000 })
    const compactSource = vi.fn(async () => await loadFixtureConversation('claude-sequence-compaction', 'claude'))
    mocks.targetProject.mockReturnValue(claudeProjection)
    mocks.targetWrite.mockResolvedValue('/claude/target.jsonl')
    mocks.targetSessionId.mockReturnValue('target-session')
    await switchProvider(
      { sourceKind: 'codex', targetKind: 'claude', sourceProviderSessionId: 'src', cwd: '/project', sourceSessionId: 'local', contextPolicy: { allowSourceTurns: true } },
      { compactSource },
    )
    expect(compactSource).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `NODE_ENV=test npx vitest run --project unit src/main/providerSwitch/switchProvider.test.ts`
Expected: FAIL — `strategy` is undefined and `compactSource` is called.

- [ ] **Step 3: Implement the policy in `switchProvider.ts`**

Replace the planning and overflow block with:

```ts
  const policy: SwitchContextPolicy = { ...DEFAULT_SWITCH_CONTEXT_POLICY, ...request.contextPolicy }
  const targetProfile = await target.targetProfile(targetCwd)
  let compactedBeforeSwitch = false
  let truncatedBeforeSwitch = false
  let strategy: SwitchStrategy = 'native'
  let shrinkSummary: string | null = null

  if (!policy.allowSourceTurns || request.overflowPolicy === 'truncate') {
    // WHY the source is never consulted on this path: the whole point of the
    // policy is that the source may be out of quota. The parser returns only
    // outcomes the host can execute alone; a ConversationUnfittableError is
    // the single legitimate failure and it aborts before any write.
    const plan = planConversationContext(conversation, targetKind, targetProfile.budgetCharacters, { allowSourceTurns: false })
    if (plan.kind === 'shrunk') {
      strategy = 'shrunk'
      shrinkSummary = describeShrink(plan.report)
      truncatedBeforeSwitch = plan.report.droppedTurns > 0
      if (request.sourceSessionId) {
        runtime.onProgress?.({ sourceSessionId: request.sourceSessionId, phase: 'shrinking', message: `History exceeds ${targetKind}; ${shrinkSummary}` })
      }
    } else if (plan.kind === 'raw-history') {
      strategy = 'raw'
    }
    conversation = plan.conversation
  } else {
    /* existing block: plan without the option, overflowPolicy 'fail', compactSource, re-plan, throw if still oversized — unchanged */
  }
```

The existing block's `if (!truncatedBeforeSwitch) conversation = plan.conversation` line moves inside the `else`. Add:

```ts
export function describeShrink(report: ShrinkReport): string {
  const parts: string[] = []
  if (report.strippedCompactions > 0) parts.push(`${report.strippedCompactions} encrypted compaction${report.strippedCompactions === 1 ? '' : 's'} dropped`)
  if (report.clearedResults > 0) parts.push(`${report.clearedResults} tool outputs cleared`)
  if (report.trimmedInputs > 0) parts.push(`${report.trimmedInputs} tool inputs trimmed`)
  if (report.droppedTurns > 0) parts.push(`${report.droppedTurns} oldest turns dropped`)
  const kb = (n: number) => `${Math.round(n / 1000)}k`
  return `${parts.join(', ') || 'no changes'} (${kb(report.estimatedCharactersBefore)} → ${kb(report.estimatedCharactersAfter)} chars)`
}
```

Return `strategy` and `shrinkSummary` in the `switched` result. Add `'shrinking'` to `ProviderSwitchProgress.phase`. Add the `SwitchContextPolicy`, `DEFAULT_SWITCH_CONTEXT_POLICY`, `SwitchStrategy` exports and the two new request fields.

- [ ] **Step 4: Pass the policy through IPC and preload**

In `src/main/ipc/provider.ts`, add `contextPolicy?: Partial<SwitchContextPolicy>` and `sourceCompactionConfirmed?: boolean` to `params`, forward both to `switchProvider(params, ...)`, and gate the native dialog:

```ts
            if (plan.kind === 'requires-compaction' && !params.sourceCompactionConfirmed) {
              /* existing dialog */
            }
```

In `src/preload/api/provider.ts`, add the same two optional params, add `strategy: 'native' | 'raw' | 'shrunk'` and `shrinkSummary: string | null` to the `switched` result type, and add `'shrinking'` to the progress phase union.

- [ ] **Step 5: Run tests and typecheck**

Run: `NODE_ENV=test npx vitest run --project unit src/main/providerSwitch && npx tsc -p tsconfig.node.json --pretty false`
Expected: PASS; no type errors. (The renderer half is type-checked in Task 8.)

- [ ] **Step 6: Commit**

```bash
git add src/main/providerSwitch/switchProvider.ts src/main/providerSwitch/switchProvider.test.ts src/main/ipc/provider.ts src/preload/api/provider.ts
git commit -m "feat(provider-switch): default to a transaction that never needs the source provider

Refs #821"
```

---

### Task 5: Hazard checks and a wait loop that can watch any session (Stage 3)

**Files:**
- Modify: `src/main/providerSwitch/compactBeforeSwitch.ts`
- Modify: `src/main/providerSwitch/compactBeforeSwitch.test.ts`

**Interfaces:**
- Consumes: `findApiErrorAfterLine`, `describeLatestCompaction` (`rejected`) from Task 1.
- Produces:

```ts
export type TranscriptWatchTarget = { sessionId: string; kind: AgentProviderKind; cwd: string; providerSessionId: string }
export async function waitForNewCompactionOn<T>(manager: SessionManager, target: TranscriptWatchTarget, beforeFingerprint: string | null, baselineLine: number, select: (c: ConversationDocument) => T): Promise<T>
export function latestSourceLine(conversation: ConversationDocument): number  // now exported
```

- [ ] **Step 1: Write the failing tests**

Append to `compactBeforeSwitch.test.ts` (same fake `manager`, `mocks.read` sequence pattern as the existing cases):

```ts
  it('fails immediately when the compaction carrier is a rate-limit message', async () => {
    const rateLimited = await loadFixtureConversation('claude-sequence-rate-limit', 'claude')
    const error = findApiErrorAfterLine(rateLimited, -1)!
    const text = String((error.source.raw.message as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '')
    mocks.read
      .mockResolvedValueOnce(baselineConversation)
      .mockResolvedValueOnce({ ...baselineConversation, entries: [...baselineConversation.entries, {
        kind: 'compaction', summary: text, summarySource: 'carrier', timestamp: null,
        source: { provider: 'claude', line: 900, raw: {}, evidence: [] },
      }] })
    await expect(compactSourceBeforeSwitch(manager, claudeRequest, requiresCompactionPlan)).rejects.toThrow(/usage limit/)
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('fails immediately when a rate-limit error lands after /compact was sent', async () => {
    const rateLimited = await loadFixtureConversation('claude-sequence-rate-limit', 'claude')
    mocks.read
      .mockResolvedValueOnce(baselineConversation)
      .mockResolvedValueOnce({ ...baselineConversation, entries: [...baselineConversation.entries, ...rateLimited.entries.filter(e => e.kind === 'opaque' && e.nativeType === 'api_error').map(e => ({ ...e, source: { ...e.source, line: 901 } }))] })
    await expect(compactSourceBeforeSwitch(manager, claudeRequest, requiresCompactionPlan)).rejects.toThrow(/usage limit/)
  })
```

`baselineConversation`, `claudeRequest`, `requiresCompactionPlan` are the objects the existing Claude test already builds; extract them to module scope if they are inline.

- [ ] **Step 2: Run to verify failure**

Run: `NODE_ENV=test npx vitest run --project unit src/main/providerSwitch/compactBeforeSwitch.test.ts`
Expected: FAIL — the wait loop accepts the carrier and, in the second case, times out (the mocked timers make it fall through to the timeout error, not the usage-limit error).

- [ ] **Step 3: Implement**

In `compactBeforeSwitch.ts`:

1. Export `latestSourceLine`.
2. Introduce `TranscriptWatchTarget` and refactor `pollSourceUntil` to take a `target: TranscriptWatchTarget` instead of `request`; `waitForNewCompaction` becomes a thin wrapper that builds the target from the request and adds `baselineLine`. Add the exported `waitForNewCompactionOn`.
3. In the compaction probe:

```ts
  }, conversation => {
    const limitError = findApiErrorAfterLine(conversation, baselineLine)
    if (limitError) {
      throw new Error(`The ${target.kind} provider reported a usage limit instead of compacting; the switch was aborted before any pane was replaced.`)
    }
    const latest = describeLatestCompaction(conversation)
    if (latest && latest.fingerprint !== beforeFingerprint) {
      if (latest.availability === 'rejected') {
        throw new Error(`The ${target.kind} provider wrote a usage-limit message where its compaction summary should be; the switch was aborted.`)
      }
      if (latest.availability !== 'incomplete') return { value: select(conversation) }
    }
    return null
  })
```

`pollSourceUntil` must let a thrown probe error propagate immediately (it currently only catches read errors inside `decodeOnce`; keep the probe call outside that try/catch).

4. Capture `baselineLine` with `latestSourceLine` in the same `readSourceAs` call that captures `beforeFingerprint` (return both from one selector so the document is not decoded twice).

- [ ] **Step 4: Run tests**

Run: `NODE_ENV=test npx vitest run --project unit src/main/providerSwitch/compactBeforeSwitch.test.ts`
Expected: PASS, existing cases unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/main/providerSwitch/compactBeforeSwitch.ts src/main/providerSwitch/compactBeforeSwitch.test.ts
git commit -m "fix(provider-switch): abort source compaction on a usage limit instead of accepting its text

Fixes #820"
```

---

### Task 6: Arrival compaction for Claude targets (Stage 5)

**Files:**
- Create: `src/main/providerSwitch/compactOnArrival.ts`
- Create: `src/main/providerSwitch/compactOnArrival.test.ts`
- Modify: `src/main/ipc/provider.ts` (register `session:compact-after-switch`)
- Modify: `src/preload/api/provider.ts` (`compactAfterSwitch`)
- Modify: `src/renderer/src/workspace/hook/actions/providerSwitchCore.ts` (fire after `replaceSession`)

**Interfaces:**
- Consumes: `waitForNewCompactionOn`, `latestSourceLine` (Task 5); `manager.getConditionsSnapshot`, `manager.write`, `manager.deliverPromptToAgent`, `manager.getSessionKind`.
- Produces:

```ts
export type CompactOnArrivalRequest = { sessionId: string; targetKind: AgentProviderKind; cwd: string; providerSessionId: string }
export type CompactOnArrivalResult = { ok: true; via: 'resume-prompt' | 'compact-command' } | { ok: false; message: string }
export async function compactOnArrival(manager: SessionManager, request: CompactOnArrivalRequest, onProgress?: (p: ProviderSwitchProgress) => void): Promise<CompactOnArrivalResult>
```

- [ ] **Step 1: Write the failing tests**

```ts
// compactOnArrival.test.ts — same vi.mock pattern as compactBeforeSwitch.test.ts for the transcript engine and timers
describe('compactOnArrival', () => {
  it('answers a visible Claude resume prompt with "Resume from summary" and waits for the carrier', async () => {
    const write = vi.fn(() => true)
    const manager = {
      getSessionKind: vi.fn(() => 'claude'),
      getConditionsSnapshot: vi.fn(() => ({
        provider: 'claude', ts: 1,
        conditions: { 'claude.resume-prompt': { kind: 'claude.resume-prompt', state: { visible: true, selectedIndex: 1 }, actions: [] } },
      })),
      write,
      deliverPromptToAgent: vi.fn(),
    }
    mocks.read.mockResolvedValueOnce(rawConversation).mockResolvedValueOnce(compactedConversation)
    const result = await compactOnArrival(manager as never, { sessionId: 'new', targetKind: 'claude', cwd: '/project', providerSessionId: 'target' })
    expect(write).toHaveBeenNthCalledWith(1, 'new', '\x1b[A')
    expect(write).toHaveBeenNthCalledWith(2, 'new', '\r')
    expect(manager.deliverPromptToAgent).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, via: 'resume-prompt' })
  })

  it('delivers /compact when no resume prompt is visible', async () => {
    const manager = {
      getSessionKind: vi.fn(() => 'claude'),
      getConditionsSnapshot: vi.fn(() => null),
      write: vi.fn(() => true),
      deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
    }
    mocks.read.mockResolvedValueOnce(rawConversation).mockResolvedValueOnce(compactedConversation)
    const result = await compactOnArrival(manager as never, { sessionId: 'new', targetKind: 'claude', cwd: '/project', providerSessionId: 'target' })
    expect(manager.deliverPromptToAgent).toHaveBeenCalledWith('new', '/compact')
    expect(result).toEqual({ ok: true, via: 'compact-command' })
  })

  it('reports rather than throws when the target is not Claude', async () => {
    const manager = { getSessionKind: vi.fn(() => 'codex') }
    const result = await compactOnArrival(manager as never, { sessionId: 'new', targetKind: 'codex', cwd: '/project', providerSessionId: 'target' })
    expect(result).toEqual({ ok: false, message: 'Arrival compaction is only implemented for Claude targets.' })
  })
})
```

`rawConversation` is the decoded `codex-sequence-compacted-once` fixture re-labeled with `sourceProvider: 'claude'` entries removed of compaction; `compactedConversation` is the decoded `claude-sequence-compaction` fixture (its carrier is portable).

- [ ] **Step 2: Run to verify failure**

Run: `NODE_ENV=test npx vitest run --project unit src/main/providerSwitch/compactOnArrival.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/main/providerSwitch/compactOnArrival.ts
// See docs/superpowers/specs/2026-09-05-quota-independent-provider-switch-design.md
// §"Arrival compaction". Runs AFTER the pane was replaced, on the new session,
// with the target's quota. Failure is reported, never fatal: the pane already
// holds the full history and the user can compact by hand.
import { setTimeout as delay } from 'node:timers/promises'
import type { SessionManager } from '@main/sessionManager.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import { conversationAfterLatestPortableCompaction, describeLatestCompaction } from 'agent-transcript-parser'
import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine.js'
import { latestSourceLine, waitForNewCompactionOn } from '@main/providerSwitch/compactBeforeSwitch.js'
import type { ProviderSwitchProgress } from '@main/providerSwitch/switchProvider.js'

export type CompactOnArrivalRequest = { sessionId: string; targetKind: AgentProviderKind; cwd: string; providerSessionId: string }
export type CompactOnArrivalResult = { ok: true; via: 'resume-prompt' | 'compact-command' } | { ok: false; message: string }

// WHY a bounded wait for the resume prompt: Claude shows it only after the
// transcript is restored, for sessions over ~100k tokens that were idle over
// an hour. A projected transcript copies the source's timestamps, so a parked
// agent usually qualifies and a just-active one does not. Ten seconds covers
// restore on the largest local transcripts (53 MB) without stalling the batch.
const RESUME_PROMPT_WAIT_MS = 10_000
const RESUME_PROMPT_POLL_MS = 250
const UP_ARROW = '\x1b[A'

export async function compactOnArrival(
  manager: SessionManager,
  request: CompactOnArrivalRequest,
  onProgress?: (progress: ProviderSwitchProgress) => void,
): Promise<CompactOnArrivalResult> {
  if (request.targetKind !== 'claude') {
    return { ok: false, message: 'Arrival compaction is only implemented for Claude targets.' }
  }
  if (manager.getSessionKind(request.sessionId) !== 'claude') {
    return { ok: false, message: 'The new pane is not a live Claude session.' }
  }
  const adapter = getHostTranscriptAdapter('claude')
  const baseline = await adapter.read(request.cwd, request.providerSessionId).then(conversation => ({
    fingerprint: describeLatestCompaction(conversation)?.fingerprint ?? null,
    line: latestSourceLine(conversation),
  }))
  const target = { sessionId: request.sessionId, kind: 'claude' as const, cwd: request.cwd, providerSessionId: request.providerSessionId }
  onProgress?.({ sourceSessionId: request.sessionId, phase: 'compacting', message: 'Compacting the imported history with Claude…' })
  try {
    const answered = await answerResumePrompt(manager, request.sessionId)
    if (!answered) {
      const delivery = await manager.deliverPromptToAgent(request.sessionId, '/compact')
      if (!delivery.ok) return { ok: false, message: `Claude did not accept /compact: ${delivery.message}` }
    }
    await waitForNewCompactionOn(manager, target, baseline.fingerprint, baseline.line, conversationAfterLatestPortableCompaction)
    return { ok: true, via: answered ? 'resume-prompt' : 'compact-command' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

async function answerResumePrompt(manager: SessionManager, sessionId: string): Promise<boolean> {
  const deadline = Date.now() + RESUME_PROMPT_WAIT_MS
  while (Date.now() < deadline) {
    const snapshot = manager.getConditionsSnapshot(sessionId)
    const record = snapshot?.conditions['claude.resume-prompt']
    const state = record?.state as { visible?: boolean; selectedIndex?: number } | undefined
    if (state?.visible) {
      // Option 1 is "Resume from summary (recommended)". The cursor defaults
      // to option 2; move it up by the observed index, then confirm. The
      // headless module deliberately exposes only confirm/cancel keystrokes
      // and leaves cursor movement to the caller.
      const moves = Math.max(0, state.selectedIndex ?? 1)
      for (let i = 0; i < moves; i += 1) manager.write(sessionId, UP_ARROW)
      manager.write(sessionId, '\r')
      return true
    }
    await delay(RESUME_PROMPT_POLL_MS)
  }
  return false
}
```

Register the IPC in `provider.ts`:

```ts
  const arrivalsInFlight = new Set<string>()
  ipcMain.handle('session:compact-after-switch', async (_evt, params: CompactOnArrivalRequest) => {
    if (arrivalsInFlight.has(params.sessionId)) return { ok: false, message: 'Arrival compaction already running.' }
    arrivalsInFlight.add(params.sessionId)
    try {
      return await compactOnArrival(manager, params, progress => {
        if (!_evt.sender.isDestroyed()) _evt.sender.send('session:provider-switch-progress', progress)
      })
    } finally {
      arrivalsInFlight.delete(params.sessionId)
    }
  })
```

Preload: `compactAfterSwitch: (params: CompactOnArrivalRequest) => Promise<CompactOnArrivalResult>`.

Renderer (`providerSwitchCore.ts`), after the successful `replaceSession` on the transcript-backed branch:

```ts
    if (params.contextPolicy?.compactOnArrival && result.targetKind === 'claude') {
      // Fire-and-forget on purpose: a batch of twenty agents must not
      // serialize twenty Claude compactions. Progress lands on the new pane
      // through the existing provider-switch progress channel.
      void window.api.compactAfterSwitch({
        sessionId: newSessionId,
        targetKind: result.targetKind,
        cwd: meta.cwd,
        providerSessionId: result.targetProviderSessionId,
      }).then(outcome => {
        if (!outcome.ok) params.onArrivalFailure?.(outcome.message)
      })
    }
```

The progress subscription in `switchAgentProvider` currently filters on `event.sourceSessionId !== sessionId`; register a second, session-scoped subscription for `newSessionId` that writes `runtime.providerSwitch` until a `null` phase or the arrival promise settles.

- [ ] **Step 4: Run tests and both typechecks**

Run: `NODE_ENV=test npx vitest run --project unit src/main/providerSwitch && npx tsc -p tsconfig.node.json --pretty false && npx tsc -p tsconfig.web.json --pretty false`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/providerSwitch/compactOnArrival.ts src/main/providerSwitch/compactOnArrival.test.ts src/main/ipc/provider.ts src/preload/api/provider.ts src/renderer/src/workspace/hook/actions/providerSwitchCore.ts
git commit -m "feat(provider-switch): compact imported history on arrival with the target's own /compact

Refs #821"
```

---

### Task 7: Exhaustion signal (Stage 4)

**Files:**
- Modify: `src/shared/types/usage.ts` (`UsageLimitRow.scope`)
- Modify: `src/main/usage/normalize.ts:64-80` (`makeUsageRow` accepts `scope`)
- Modify: `src/main/usage/claudeUsage.ts`, `src/main/usage/codexUsage.ts`
- Create: `src/shared/usage/exhaustion.ts`, `src/shared/usage/exhaustion.test.ts`
- Modify: `src/main/usage/usageNormalize.test.ts`

**Interfaces:**
- Produces:

```ts
export type UsageLimitScope = 'all-models' | 'model-family' | 'unknown'
// UsageLimitRow gains: scope: UsageLimitScope
export type ProviderExhaustion = { provider: UsageProviderKind; exhausted: boolean; scope: UsageLimitScope; resetsAt: string | null; label: string }
export function deriveProviderExhaustion(snapshot: UsageProviderSnapshot): ProviderExhaustion
```

- [ ] **Step 1: Write the failing tests**

In `usageNormalize.test.ts`, extend the existing real-payload cases:

```ts
  it('scopes Claude rows: session and weekly_all are all-models, weekly_scoped is model-family', () => {
    const rows = normalizeClaudeUsagePayload(REAL_CLAUDE_PAYLOAD).rows
    expect(rows.find(r => r.label === 'Current session')?.scope).toBe('all-models')
    expect(rows.find(r => r.label === 'Current week (all models)')?.scope).toBe('all-models')
    expect(rows.find(r => r.label.startsWith('Current week ('))?.scope ?? 'model-family').toBe('model-family')
  })
  it('scopes Codex rows: the main rate_limit is all-models, additional limits are model-family', () => {
    const rows = normalizeCodexUsagePayload(REAL_CODEX_PAYLOAD).rows
    expect(rows.filter(r => r.id.startsWith('codex-')).every(r => r.scope === 'all-models')).toBe(true)
  })
```

`src/shared/usage/exhaustion.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { deriveProviderExhaustion } from './exhaustion.js'
const row = (o: Partial<import('@shared/types/usage.js').UsageLimitRow>) => ({
  id: 'x', label: 'x', percent: 0, severity: 'normal' as const, resetsAt: null, active: true, detail: null, scope: 'all-models' as const, ...o,
})
const ok = (rows: ReturnType<typeof row>[]) => ({ provider: 'claude' as const, status: 'ok' as const, sourceLabel: 's', plan: null, rows, spend: null, extraUsage: null, credits: null })
describe('deriveProviderExhaustion', () => {
  it('is exhausted with all-models scope when a shared window is at 100', () => {
    expect(deriveProviderExhaustion(ok([row({ label: 'Current session', percent: 100, resetsAt: '2026-09-05T16:00:00Z' })])))
      .toEqual({ provider: 'claude', exhausted: true, scope: 'all-models', resetsAt: '2026-09-05T16:00:00Z', label: 'Current session' })
  })
  it('is exhausted with model-family scope when only a scoped weekly row is at 100', () => {
    const result = deriveProviderExhaustion(ok([row({ label: 'Current week (Fable)', percent: 100, scope: 'model-family' }), row({ label: 'Current session', percent: 40 })]))
    expect(result.exhausted).toBe(true)
    expect(result.scope).toBe('model-family')
  })
  it('is not exhausted below 100 and unknown on error snapshots', () => {
    expect(deriveProviderExhaustion(ok([row({ percent: 99.4 })])).exhausted).toBe(false)
    expect(deriveProviderExhaustion({ provider: 'codex', status: 'error', sourceLabel: 's', message: 'boom' })).toMatchObject({ exhausted: false, scope: 'unknown' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `NODE_ENV=test npx vitest run --project unit src/main/usage src/shared/usage`
Expected: FAIL — `scope` undefined; module missing.

- [ ] **Step 3: Implement**

`usage.ts`: add `UsageLimitScope` and `scope: UsageLimitScope` on `UsageLimitRow`. `normalize.ts` `makeUsageRow`: accept `scope?: UsageLimitScope`, default `'unknown'`, copy through. `claudeUsage.ts`: in the rows map, compute `scope` from `stringOrNull(limit.kind)`: `session` and `weekly_all` → `'all-models'`, `weekly_scoped` → `'model-family'`, else `'unknown'`, and pass it. `codexUsage.ts`: `codexRowsFromRateLimit` gains a `scope` parameter; the main `rate_limit` call passes `'all-models'`, the `additional_rate_limits` loop passes `'model-family'`, `limits` entries pass `'unknown'`.

```ts
// src/shared/usage/exhaustion.ts
import type { UsageLimitRow, UsageLimitScope, UsageProviderKind, UsageProviderSnapshot } from '@shared/types/usage.js'

export type ProviderExhaustion = {
  provider: UsageProviderKind
  exhausted: boolean
  scope: UsageLimitScope
  resetsAt: string | null
  label: string
}

// WHY 100 and not the 95 "critical" threshold: severity colors a header; this
// value gates defaults in a modal that moves agents. A window at 96 percent
// still accepts turns. Only a window the provider reports as fully used is
// treated as exhausted, and the modal always lets the user override.
const EXHAUSTED_PERCENT = 100

export function deriveProviderExhaustion(snapshot: UsageProviderSnapshot): ProviderExhaustion {
  if (snapshot.status !== 'ok') {
    return { provider: snapshot.provider, exhausted: false, scope: 'unknown', resetsAt: null, label: snapshot.message }
  }
  const hit = (scope: UsageLimitScope): UsageLimitRow | undefined => snapshot.rows.find(row => (
    row.active && row.scope === scope && row.percent !== null && row.percent >= EXHAUSTED_PERCENT
  ))
  const shared = hit('all-models')
  if (shared) return { provider: snapshot.provider, exhausted: true, scope: 'all-models', resetsAt: shared.resetsAt, label: shared.label }
  const family = hit('model-family')
  if (family) return { provider: snapshot.provider, exhausted: true, scope: 'model-family', resetsAt: family.resetsAt, label: family.label }
  return { provider: snapshot.provider, exhausted: false, scope: 'unknown', resetsAt: null, label: '' }
}
```

- [ ] **Step 4: Run tests**

Run: `NODE_ENV=test npx vitest run --project unit src/main/usage src/shared/usage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/usage.ts src/shared/usage src/main/usage
git commit -m "feat(usage): scope limit rows and derive a structural exhaustion signal

Refs #821"
```

---

### Task 8: Renderer runtime signal, guard, batch policy, and modal (Stage 6)

**Files:**
- Modify: `src/renderer/src/session-runtime/state.ts:552` (`limitHit`), `:823` (`emptyRuntime`)
- Modify: `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts:1455` (JSONL handler) and `:1136` (semantic api_error)
- Modify: `src/renderer/src/workspace/hook/actions/providerSwitchCore.ts` (guard, `contextPolicy`, strategy in result)
- Modify: `src/renderer/src/workspace/hook/actions/bulkProviderSwitch.ts` (policy parameter, strategy tally)
- Modify: `src/renderer/src/workspace/hook/index.ts:835,983` (pass-through only)
- Modify: `src/renderer/src/features/workspace/ui/BulkProviderSwitchModal.tsx`
- Create: `src/renderer/src/features/workspace/ui/BulkProviderSwitchModal.policy.renderer.test.tsx`
- Create: `src/renderer/src/workspace/hook/actions/providerSwitchCore.limitIdle.test.ts`

**Interfaces:**
- Consumes: `deriveProviderExhaustion`, `useUsageHeaderSnapshot`, `SwitchContextPolicy` (via preload types).
- Produces: `SessionRuntime.limitHit: { at: number; source: 'transcript' | 'api_error' } | null`; `switchAgentsToProvider(sessionIds, targetKind, policy: { allowSourceTurns: boolean; compactOnArrival: boolean; sourceCompactionConfirmed: boolean })`; `SwitchAgentProviderResult` `switched` gains `strategy: 'native' | 'raw' | 'shrunk'`; `isLimitIdle(runtime): boolean` exported from `providerSwitchCore.ts`.

- [ ] **Step 1: Write the failing guard test**

```ts
// providerSwitchCore.limitIdle.test.ts
import { describe, expect, it } from 'vitest'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { isLimitIdle } from './providerSwitchCore'
describe('isLimitIdle', () => {
  it('treats a process still marked active as idle when a limit hit is newer than the last turn start', () => {
    const runtime = { ...emptyRuntime(), processActive: true, turnStartedAt: 1_000, limitHit: { at: 2_000, source: 'transcript' as const } }
    expect(isLimitIdle(runtime)).toBe(true)
  })
  it('does not override a genuinely running turn', () => {
    const runtime = { ...emptyRuntime(), processActive: true, turnStartedAt: 3_000, limitHit: { at: 2_000, source: 'transcript' as const } }
    expect(isLimitIdle(runtime)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `NODE_ENV=test npx vitest run --project unit src/renderer/src/workspace/hook/actions/providerSwitchCore.limitIdle.test.ts`
Expected: FAIL — `isLimitIdle` and `limitHit` do not exist.

- [ ] **Step 3: Implement the runtime field and guard**

`state.ts`: add after `processActive`:

```ts
  /** Set when the provider reported a usage limit (Claude: an api_error
   *  transcript record; Codex: a usage_limit_reached api error on the
   *  semantic stream). Compared against turnStartedAt so a pane that is
   *  "active" only because it shows the provider's wait banner can still be
   *  switched away. Cleared when the next turn completes. */
  limitHit: { at: number; source: 'transcript' | 'api_error' } | null
```

and `limitHit: null` in `emptyRuntime()`.

`useIpcSubscriptions.ts`, JSONL handler: before mapping, compute

```ts
      const limitRecord = entries.find(raw => isRecord(raw) && raw.type === 'assistant' && raw.isApiErrorMessage === true && raw.error === 'rate_limit')
```

and when found, set `limitHit: { at: Date.now(), source: 'transcript' }` on the runtime in the same reducer that folds the entries. Semantic handler (`api_error` case): when `ev.errorType === 'usage_limit_reached'`, set `limitHit: { at: now, source: 'api_error' }`. In the `turn_completed` fold, set `limitHit: null`.

`providerSwitchCore.ts`:

```ts
export function isLimitIdle(runtime: Pick<SessionRuntime, 'limitHit' | 'turnStartedAt'>): boolean {
  return runtime.limitHit !== null && (runtime.turnStartedAt === null || runtime.limitHit.at >= runtime.turnStartedAt)
}
```

and change the guard to:

```ts
  if ((sourceRuntime?.processActive || sourceRuntime?.semantic.currentTurn) && !(sourceRuntime && isLimitIdle(sourceRuntime))) {
    return { status: 'failed', message: 'Wait for the current turn to finish before switching provider' }
  }
```

Add `contextPolicy` and `sourceCompactionConfirmed` to the `switchAgentProvider` params and forward them in the `window.api.switchProvider` call; include `strategy: result.strategy` in the `switched` result.

- [ ] **Step 4: Batch policy and tally**

`bulkProviderSwitch.ts`: `switchAgentsToProvider(sessionIds, targetKind, policy)` forwards `contextPolicy: { allowSourceTurns: policy.allowSourceTurns, compactOnArrival: policy.compactOnArrival }` and `sourceCompactionConfirmed: policy.sourceCompactionConfirmed`; tally `native`, `raw`, `shrunk` counts from `result.strategy`; toast becomes:

```ts
      const tally = [
        counts.native > 0 ? `${counts.native} native` : null,
        counts.raw > 0 ? `${counts.raw} raw` : null,
        counts.shrunk > 0 ? `${counts.shrunk} shrunk` : null,
      ].filter(Boolean).join(', ')
      const base = `Switched ${pluralAgents(switched.length)} to ${providerLabel(targetKind)}${tally ? `: ${tally}` : ''}`
```

`returnLastProviderSwitchBatch` uses `{ allowSourceTurns: false, compactOnArrival: batch.sourceKind === 'claude', sourceCompactionConfirmed: false }`.

`hook/index.ts`: no signature change beyond the new parameter flowing through.

- [ ] **Step 5: Write the failing modal test**

```tsx
// BulkProviderSwitchModal.policy.renderer.test.tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
vi.mock('@renderer/features/usage/hooks/useUsageHeaderSnapshot', () => ({
  useUsageHeaderSnapshot: () => ({ stale: false, snapshot: { fetchedAt: '2026-09-05T12:00:00Z', cache: { hit: false, ttlMs: 30000 }, providers: [
    { provider: 'codex', status: 'ok', sourceLabel: 's', plan: 'pro', spend: null, extraUsage: null, credits: null, rows: [
      { id: 'codex-primary-window', label: 'Codex 5h', percent: 100, severity: 'critical', resetsAt: '2026-09-05T14:32:00Z', active: true, detail: null, scope: 'all-models' },
    ] },
    { provider: 'claude', status: 'ok', sourceLabel: 's', plan: 'max', spend: null, extraUsage: null, credits: null, rows: [] },
  ] } }),
}))
import { BulkProviderSwitchModal } from './BulkProviderSwitchModal'
import { makeWorkspaceStub } from '../testing/workspaceStub' // the stub the other modal tests use; create it here if none exists

describe('BulkProviderSwitchModal policy', () => {
  it('defaults the direction to the exhausted provider and disables source compaction', () => {
    render(<BulkProviderSwitchModal open workspace={makeWorkspaceStub()} onClose={() => {}} />)
    expect(screen.getByText(/Codex.*100.*resets/i)).toBeInTheDocument()
    expect((screen.getByLabelText(/Compact on source first/i) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByDisplayValue(/Codex → Claude/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: Implement the modal changes**

In `BulkProviderSwitchModal.tsx`:

- Read `const { snapshot } = useUsageHeaderSnapshot()` and derive `exhaustion = snapshot?.providers.map(deriveProviderExhaustion) ?? []`.
- On open, if exactly one provider is exhausted, set `directionKey` to `${that}:${firstSwitchTarget}`.
- Render a banner row per exhausted provider: `{providerLabel(p.provider)}: {p.label} at 100%{p.resetsAt ? `, resets ${formatTime(p.resetsAt)}` : ''}` with `formatTime` from `features/usage/model/formatUsage.ts`.
- Two checkboxes with local state: `compactOnArrival` (rendered only when `target === 'claude'`, default `true`), `compactOnSource` (default `false`, `disabled` with title "Source provider is exhausted" when `exhaustion.find(e => e.provider === source)?.exhausted`).
- "Switch model instead" row: rendered only when the source is `claude` and its exhaustion scope is `model-family`; button label `Switch {N} agents to another Claude model` calling `workspace.deliverPromptToSessions(ids, '/model sonnet')` if such an action exists, otherwise looping `window.api.deliverPrompt(sessionId, '/model sonnet')`; on completion toast. This is Claude-only by design (spec §Renderer).
- `runSwitch` passes `{ allowSourceTurns: compactOnSource, compactOnArrival, sourceCompactionConfirmed: compactOnSource }` and, when `compactOnSource` is true, first shows an in-modal confirmation paragraph with a second click required ("Compact N agents on {source} first — this rewrites their live history and uses {source} quota").
- The ⚠ line changes to: `{midTurnCount} of {n} are mid-turn and will be skipped until idle; agents stopped by a usage limit are included.` where `isLive` for a row is `runtime.processActive && !isLimitIdle(runtime)`.

- [ ] **Step 7: Run renderer tests, unit tests, and the web typecheck**

Run: `NODE_ENV=test npx vitest run --project renderer src/renderer/src/features/workspace/ui/BulkProviderSwitchModal.policy.renderer.test.tsx && NODE_ENV=test npx vitest run --project unit src/renderer/src/workspace && npx tsc -p tsconfig.web.json --pretty false && npm run check:keybindings`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/session-runtime/state.ts src/renderer/src/workspace/hook src/renderer/src/features/workspace/ui
git commit -m "feat(workspace): read exhaustion in the bulk switch, ask once, and label each agent's strategy

Refs #821"
```

---

### Task 9: Integration, design doc, pointers, probe, PR (Stage 7)

**Files:**
- Modify: `docs/design/provider-switching.md`
- Modify: `package-lock.json` (resync), submodule pointers `packages/agent-transcript-parser`, `packages/codex-headless`, `vendor/codex-src`
- Modify: `packages/agent-transcript-parser/testing/live-resume-probe.mts` (shrunk case)

- [ ] **Step 1: Bump the package pointers and resync the lockfile (do this BEFORE Task 4 compiles)**

```bash
git add packages/agent-transcript-parser packages/codex-headless
NODE_ENV=development npm install --include=dev
git add package-lock.json
git commit -m "build(deps): point at the parser and codex-headless branches for quota-independent switching

Refs #821"
```

The parser and codex-headless commits must be pushed to their branches first so CI can fetch them; record the two branch names in the PR body.

- [ ] **Step 2: Commit the vendored Codex pointer**

```bash
git add vendor/codex-src
git commit -m "chore(vendor): move vendored Codex source to upstream main

The provider-switch design cites the current remote compaction, rollout
persistence and external-agent import code; the April checkout predates
all three.

Refs #821"
```

- [ ] **Step 3: Update the design doc**

In `docs/design/provider-switching.md`: replace the "Capacity outcomes" table with the six-outcome table from the spec, rewrite "Source transcript mutation" to state that source-side compaction is opt-in and disabled while the source is exhausted, add an "Arrival compaction" section, add the `rejected` availability and the API-error decode rule to "Claude compaction", and add the shrink ladder and its isolation to the "Code map" and "Warning" sections. Keep the "Warning" sentence that no fallback silently truncates; the ladder is explicit and reported.

```bash
git add docs/design/provider-switching.md
git commit -m "docs(provider-switch): describe quota-independent outcomes, opt-in source compaction and arrival compaction

Refs #821"
```

- [ ] **Step 4: Extend the live probe (parser repo) and run it once**

Add a `--strategy raw|shrunk` flag to `live-resume-probe.mts` that plans with `{ allowSourceTurns: false }` and, for `shrunk`, passes a budget one quarter of the real one so the ladder runs. Run, opt-in, against one real Codex compacted session and one real oversized Claude session:

```bash
cd packages/agent-transcript-parser
npm run probe:live-resume -- --source codex --target claude --strategy raw --session <id>
npm run probe:live-resume -- --source codex --target claude --strategy shrunk --session <id>
npm run probe:live-resume -- --source claude --target codex --strategy shrunk --session <id>
```

Read the three responses for meaning: the marker must be answered and the model must reference the most recent work, not claim an empty history. Record real token counts from the probe against the character estimate (Unknown 2). Attach the report to the PR; do not commit it.

- [ ] **Step 5: Full gate**

Run in the worktree: `npm run typecheck && npm test && npm run check:keybindings`
Expected: PASS. Then `npm run test:package` once.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/quota-independent-provider-switch
gh pr create --title "feat(provider-switch): switch agents off an exhausted provider without a source-side summarization turn" --body-file <body>
```

Body: problem, implemented behavior, design decisions (raw carry-over, deterministic shrink, arrival compaction, opt-in source path), `Fixes #821`, `Fixes #820`, `Refs #360 #720 #756`, the two package PR links, tests and probe report, limitations (Unknowns 1–8 from the decomposition with their resolutions), and the note that the vendored Codex pointer moved. End with the generated-with footer and session link. Stop. Do not merge.

---

## Self-review

- Spec coverage: planner outcomes (Task 2), shrink ladder (Task 2), hazard fixes (Tasks 1, 5), transaction policy and strategy (Task 4), arrival compaction (Task 6), exhaustion signal incl. codex-headless classification (Tasks 3, 7), modal banner/checkboxes/one confirmation/strategy summary/switch-model row (Task 8), guard (Task 8), design doc and probe (Task 9), coordination boundaries (Global Constraints). Out-of-scope items are not planned.
- Type consistency: `SwitchContextPolicy`, `SwitchStrategy`, `ShrinkReport`, `describeShrink`, `waitForNewCompactionOn`, `TranscriptWatchTarget`, `isLimitIdle`, `deriveProviderExhaustion`, `UsageLimitScope` are defined once and used with the same names in later tasks.
- Ordering: Task 0 needs approval before Task 2; Task 9 Step 1 (pointer bump) must precede Task 4's compile; Task 3 can run in parallel with Tasks 1–2.
