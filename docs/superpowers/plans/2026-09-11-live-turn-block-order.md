# Live Turn Block Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a Claude turn streams, a block that has already been written to the transcript stays where it was produced, above the turn's still-streaming blocks, instead of dropping below them.

**Architecture:** One amendment to the ledger's ordering law (`src/renderer/src/rendering/model/order.ts`): a committed candidate whose `messageId` is the id of a selected `semantic-current` turn takes that turn's time slot, and the existing equal-time tiebreak (committed before semantic-current) places it ahead of the turn's live blocks. Ownership (D3) is untouched; only placement changes.

**Tech Stack:** TypeScript, Vitest 4 (`unit` project).

**Spec:** GitHub issue #868.

## Global Constraints

- Worktree `.worktrees/live-turn-block-order`, branch `fix/live-turn-block-order`, based on `origin/main` @ `fddf2596`.
- Node 24 for tests (`source /opt/homebrew/opt/nvm/nvm.sh && nvm use 24`); type gate `npx tsc -b --pretty false` / `npm run typecheck`.
- Never launch the app. Thick WHY comments. Conventional Commits, scope `rendering`.
- Run the rendering corpus (`bundleCorpus.test.ts`, `recordingCorpus.test.ts`) before the PR: an ordering change is exactly what that net exists to catch.

## Root cause and evidence

- `rendering/observations/semantic.ts` `collectTurn` stamps every block of the **current** turn with the turn's `startedAtMs` (local receipt time).
- `rendering/model/order.ts` merges planes by `timestampMs`; a committed JSONL line carries its producer timestamp.
- Claude Code writes **one JSONL line per content block as the block completes**, in block order, all with the message's `message.id`. Measured on real transcripts in `~/.claude/projects/-Users-juliusolsson-Desktop-Development-agent-code/` (offsets from the first line of the message): `[thinking 0.0s, text +0.84s, tool_use +2.27s, tool_use +4.01s]`, `[thinking 0.0s, text +1.48s, tool_use +4.82s, tool_use +5.71s]`, `[thinking 0.0s, text +0.86s, tool_use +9.79s, tool_use +30.4s]`.
- So while a turn streams, its committed lines are a prefix of its blocks, but each carries a later time than the turn start and sorts below every live block. The common visible case is not only #868's web-search shape: in any "text, then tool call" message the explanatory text drops below the streaming tool call until the tool_use line lands (up to ~30s for large tool inputs above).

## Why this fix and not the alternatives

- **Per-block start times** (stamp `block_started` receipt time and order live blocks by it): still compares a producer clock (JSONL timestamp) with a local receipt clock (proxy poll delivery, 0–200ms+ late), so the order would depend on a race.
- **Anchor a committed row to the semantic block it suppressed**: deterministic, but ownership keeps only key sets (no committed-id per suppressed candidate), and several committed rows of the turn (thinking, text) suppress different things or nothing.
- **Anchor by message identity** (chosen): the committed rows of the live message are, by the producer's write order, earlier than every still-live block of it. Identity is already the ledger's Claude handoff key (whole-turn ownership, `ownership.ts`). No clock comparison is involved, and the anchor is the turn's own slot, so the rows also stay after any previous turn that ended before this one started, regardless of producer/receipt clock skew.
- Scope is message identity, so it applies whenever ids match; Codex/OpenCode committed ids that differ from their semantic turn ids are unaffected.

---

### Task 1: Committed rows of the live turn order inside it

**Files:**
- Modify: `src/renderer/src/rendering/model/order.ts`
- Test: `src/renderer/src/rendering/model/ledger.test.ts` (ordering law describe)
- Test: `src/renderer/src/features/feed/ledger/ledgerFeedItems.test.ts` (view bridge, real fold)

- [ ] **Step 1: Failing ledger tests**
  1. Prompt at T0; live turn `msg_1` has a `semantic-current` tool_use block stamped T0+100 (turn start); the committed text line of `msg_1` at T0+150. Expected rows: prompt, committed text, live tool_use (today: prompt, live tool_use, committed text).
  2. Clock skew: a `semantic-history` turn ended at T0+120 (local), the live turn started at T0+130 (local), its committed line has producer time T0+110. Expected: history, committed, live (anchoring to the turn slot, not `min`, keeps it after the previous turn).
  3. A committed row whose `messageId` matches no live turn keeps its own time.
- [ ] **Step 2: Failing view-bridge test** with the production fold: a `msg_live` turn streams a text block then a tool_use block; the text's committed entry (same `message.id`, later timestamp) lands while the tool_use input still streams. Expected items: prompt, committed text entry, live tool_use block, work.
- [ ] **Step 3: Implement** the anchor in `orderCandidates`: build `turnId → timestampMs` from selected `semantic-current` candidates; a `committed` candidate whose `messageId` is in that map sorts at the mapped time (tiebreak unchanged). Record the anchoring in the row's `order.source` so a debug bundle explains the placement (D5).
- [ ] **Step 4: Verify** the ledger, view-bridge, and rendering corpus suites (`src/renderer/src/rendering/*Corpus.test.ts`), then `tsc -b`.
- [ ] **Step 5: Commit** `fix(rendering): keep committed blocks of a live turn above its streaming blocks` with `Fixes #868`.

### Task 2: PR

- [ ] Full `npm test` once (known local env failures: see memory; compare against origin/main if anything else fails), push, open the PR with `Fixes #868`. Do not merge.

## Implementation note (scope extended during Task 1)

The first version anchored only committed rows whose `messageId` matched the live turn. The rendering corpus flagged two real bundles (`2026-06-22 …7733b0fc`, `2026-06-29 …1b2b5e96`): Claude Code **executes a tool as soon as its tool_use block completes, while the message still streams**. In 7733b0fc the tool_use line lands at 42.238s, its tool_result 9ms later, the next tool_use at 44.141s, and block 2 is still live. Tool results are user rows with no `message.id`, so they stayed at their own time and sank below the live block, separated from their tool calls.

The anchor now also covers a committed row whose `ownedToolResultIds` answer a tool_use id of the live turn (from its committed tool_use lines or live tool blocks). With every anchored row tied at the turn's slot, `sequence` orders them in transcript order. Both bundles then match their recorded triage exactly, with no re-bless, which independently confirms the order is the transcript's. The added ledger test encodes the 7733b0fc shape.
