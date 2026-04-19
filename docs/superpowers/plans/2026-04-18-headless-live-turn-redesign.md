# Headless Live-Turn Ownership Redesign

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Claude and Codex headless pipelines so a session has exactly one authoritative live-turn producer at a time. Stop letting proxy, screen, and committed sources co-own the same live assistant turn. Move screen parsing back to overlay/status duty, keep committed transcript durable and separate, and make the renderer consume one resolved live model instead of merging several partially-healed truths.

**Architecture:** Split each headless package into three explicit roles:
- `authoritative live source` for the current turn
- `reconciliation source` for late or durable confirmation
- `overlay source` for terminal UI like approvals, trust dialogs, slash pickers, and working status

The central rule is: **only one source may publish semantic turn mutations for a given turn lifecycle.** Other sources may confirm, finalize, or enrich metadata, but they may not mutate the visible live turn once ownership is assigned.

**Tech Stack:** TypeScript, Node.js, xterm, existing headless channels. No new runtime deps.

---

## Why the current model keeps breaking

Both headless packages already describe the same conceptual split:

- `semantic` = what the model is saying now
- `screen` = what the terminal UI is painting now
- `committed` = what the transcript/rollout has durably written

The problem is that the orchestrators still let multiple sources feed the same live semantic slot.

### Current failure modes

1. **Too many live producers**
   - Claude can publish live semantics from proxy, screen fallback, and committed tool-result bridging.
   - Codex can publish live semantics from proxy, rollout, and screen fallback.

2. **Channels auto-heal producer incoherence**
   - `claude-code-headless/src/channels/SemanticChannel.ts`
   - `codex-headless/src/channels/SemanticChannel.ts`

   These channels silently auto-start and auto-finish turns on mismatched deltas. That keeps data flowing, but it means adapters are not required to be coherent.

3. **Committed data leaks back into live semantic state**
   - Most visibly on Claude via committed `tool_result` mirroring in `claude-code-headless/src/ClaudeCodeHeadless.ts`.

4. **Screen parsing is still treated as content fallback**
   - This is useful for overlays and working state.
   - It is not reliable enough to co-own the assistant turn.

5. **Renderer/reducer has to merge already-merged truth**
   - By the time cc-shell receives events, the headless layer has often already blended sources.
   - The renderer then tries to dedupe and guess ownership again.

This plan fixes the problem at the headless boundary, where it belongs.

---

## Design rules

### Rule 1. One live owner per turn

At any moment, a session may have **zero or one** authoritative live source:

- Claude preferred order:
  1. `proxy`
  2. `screen` only as temporary pre-proxy fallback
  3. never `committed` as a live producer

- Codex preferred order:
  1. `proxy` when enabled
  2. `rollout` when proxy is unavailable or intentionally disabled
  3. `screen` only as temporary pre-authoritative fallback

### Rule 2. Ownership assignment is explicit

Each headless package must track:

- `liveOwner.kind`: `'proxy' | 'rollout' | 'screen' | null`
- `liveOwner.turnId`
- `liveOwner.startedAt`
- `liveOwner.status`: `'idle' | 'live' | 'reconciling'`

Ownership changes are explicit transitions, not side effects of mismatched deltas.

### Rule 3. Secondary sources are reconciliation-only

After a live owner is chosen:

- secondary sources may publish:
  - confirmation
  - usage
  - stop reason
  - durable completion
  - debug/trace events
- secondary sources may **not** publish:
  - text deltas
  - block start/end
  - tool lifecycle mutations
  - turn restarts

### Rule 4. Screen is overlay/status, not assistant truth

Screen parsing remains valid for:

- approvals
- trust dialogs
- slash pickers
- compaction/resume prompts
- working/activity state

Screen parsing is not allowed to own assistant content once proxy or rollout has claimed the turn.

### Rule 5. SemanticChannel becomes strict transport, not a healer

`SemanticChannel` should stop auto-repairing source mistakes. Adapters and orchestrators must send coherent lifecycle.

If an event arrives for the wrong turn:

- log/debug it
- drop it
- do not seal the old turn and open a new one implicitly

---

## Target state by package

## Claude

### Intended ownership model

- `proxy` owns live assistant text, blocks, tools, usage deltas, and completion when proxy is available.
- `screen` may open a temporary live turn only before proxy has claimed one.
- `committed` confirms durability and appends transcript history, but never mutates the active semantic turn.

### Files most affected

- `claude-code-headless/src/ClaudeCodeHeadless.ts`
- `claude-code-headless/src/channels/SemanticChannel.ts`
- `claude-code-headless/src/proxy/ClaudeProxyAdapter.ts`
- `claude-code-headless/src/parsers/ScreenParser.ts`
- `claude-code-headless/src/channels/types.ts`

### Specific Claude problems to remove

- committed `tool_result` mirroring into semantic
- screen fallback continuing after proxy has live ownership
- orchestrator-level promotion logic that mutates the active turn instead of closing one owner and opening another

## Codex

### Intended ownership model

- `proxy` owns live semantics when proxy is enabled and healthy.
- `rollout` owns live semantics when proxy is unavailable.
- `screen` may only act before proxy/rollout ownership exists, and must immediately yield once a stronger source appears.

### Files most affected

- `codex-headless/src/CodexHeadless.ts`
- `codex-headless/src/channels/SemanticChannel.ts`
- `codex-headless/src/proxy/CodexResponsesAdapter.ts`
- `codex-headless/src/proxy/responsesProxy.ts`
- `codex-headless/src/parsers/ScreenParser.ts`
- `codex-headless/src/channels/types.ts`

### Specific Codex problems to remove

- proxy and rollout both behaving like live semantic authorities for the same session
- screen fallback racing the active channel after a proxy or rollout turn exists
- adapter richness diverging from rollout semantics without an explicit ownership boundary

---

## New shared model

Add a stricter ownership structure to both packages.

### New types

Add to both `channels/types.ts` files:

```ts
export type LiveOwnerKind = 'proxy' | 'rollout' | 'screen'

export interface LiveOwnerState {
  kind: LiveOwnerKind | null
  turnId: string | null
  startedAt: number | null
  status: 'idle' | 'live' | 'reconciling'
}
```

Add orchestrator-only helpers:

```ts
interface OwnershipDecision {
  accept: boolean
  reason: string
  action: 'start' | 'drop' | 'promote' | 'finalize'
}
```

### New responsibilities

- Adapters produce coherent source-local events.
- Headless orchestrators assign and enforce ownership.
- SemanticChannel forwards valid lifecycle only.
- Renderer consumes one live semantic timeline plus committed transcript.

---

## Implementation plan

## Phase 1. Make ownership explicit in both headless orchestrators

### Task 1. Add `liveOwner` state to Claude and Codex headless classes

**Files:**
- `claude-code-headless/src/ClaudeCodeHeadless.ts`
- `codex-headless/src/CodexHeadless.ts`
- `claude-code-headless/src/channels/types.ts`
- `codex-headless/src/channels/types.ts`

- [ ] Add a `liveOwner` field to both headless classes.
- [ ] Add helper methods:
  - `claimLiveOwner(kind, turnId, reason)`
  - `clearLiveOwner(reason)`
  - `canSourceMutateLiveTurn(kind, turnId)`
  - `transitionLiveOwner(nextKind, nextTurnId, reason)`
- [ ] Emit lightweight debug events when ownership is claimed, denied, promoted, or cleared.

**Success criteria:**
- Headless packages have a single in-memory owner record.
- Every live semantic mutation can be checked against that record.

### Task 2. Stop storing source truth only in ad hoc fields

**Files:**
- `claude-code-headless/src/ClaudeCodeHeadless.ts`
- `codex-headless/src/CodexHeadless.ts`

- [ ] Audit and reduce fields like:
  - `liveSemanticTurnId`
  - `semanticSource`
  - any provider-specific booleans that imply ownership indirectly
- [ ] Replace them with `liveOwner`.
- [ ] Keep derived convenience fields only if they are pure views over `liveOwner`.

**Success criteria:**
- Ownership logic is no longer spread across several loosely-coupled fields.

## Phase 2. Make SemanticChannel strict

### Task 3. Remove auto-healing turn swaps from both semantic channels

**Files:**
- `claude-code-headless/src/channels/SemanticChannel.ts`
- `codex-headless/src/channels/SemanticChannel.ts`

- [ ] Remove implicit "finish current and reopen new" behavior on mismatched `turnId`.
- [ ] Replace it with:
  - drop event
  - emit debug/diagnostic event
  - preserve current active turn
- [ ] Keep explicit `startTurn`, `finishTurn`, `applyDelta`, `publishBlockStarted`, `publishBlockDelta`, `publishBlockCompleted`, `publishUsageUpdated`.
- [ ] Require callers to send legal lifecycle.

**Success criteria:**
- Channels no longer hide source-level incoherence.
- Any cross-turn mutation must be explicit in the orchestrator.

### Task 4. Add channel tests for illegal lifecycle

**Files:**
- `claude-code-headless/src/channels/SemanticChannel.ts`
- `codex-headless/src/channels/SemanticChannel.ts`
- corresponding test files or new `src/testing` coverage

- [ ] Add tests covering:
  - delta before start
  - mismatched turn delta while active turn exists
  - block events for non-owned turn
  - explicit complete then explicit new start

**Success criteria:**
- The strict behavior is locked in with tests before orchestrator refactors land.

## Phase 3. Claude ownership enforcement

### Task 5. Make Claude proxy the only authoritative live semantic source

**Files:**
- `claude-code-headless/src/ClaudeCodeHeadless.ts`
- `claude-code-headless/src/proxy/ClaudeProxyAdapter.ts`

- [ ] Treat proxy as the only source allowed to publish live text/block/tool mutations after it claims ownership.
- [ ] When proxy starts a turn:
  - `claimLiveOwner('proxy', turnId, ...)`
  - block screen from further semantic mutations
- [ ] When proxy completes:
  - finalize the turn
  - move owner to `reconciling` until committed transcript confirms durability
  - then clear owner

**Success criteria:**
- Once proxy is active, screen can no longer modify the live assistant turn.

### Task 6. Remove committed `tool_result` mirroring into Claude semantic live state

**Files:**
- `claude-code-headless/src/ClaudeCodeHeadless.ts`

- [ ] Identify the committed-to-semantic bridge for `tool_result` and related transcript artifacts.
- [ ] Replace semantic mutation with one of:
  - committed-channel only event
  - reconciliation metadata event
  - debug event
- [ ] If renderer still needs these artifacts, deliver them through committed history, not active semantic turn mutation.

**Success criteria:**
- Committed transcript no longer re-opens or mutates the live semantic turn.

### Task 7. Constrain Claude screen fallback to pre-owner fallback only

**Files:**
- `claude-code-headless/src/ClaudeCodeHeadless.ts`
- `claude-code-headless/src/parsers/ScreenParser.ts`

- [ ] Screen may open a temporary semantic turn only if `liveOwner.kind === null`.
- [ ] The moment proxy claims ownership:
  - complete or discard the screen fallback turn explicitly
  - clear screen ownership
- [ ] Keep screen parsing for overlays and activity state even after proxy ownership.

**Success criteria:**
- Claude screen parsing no longer races the proxy for content ownership.

## Phase 4. Codex ownership enforcement

### Task 8. Choose one live authority for Codex: proxy or rollout

**Files:**
- `codex-headless/src/CodexHeadless.ts`
- `codex-headless/src/proxy/CodexResponsesAdapter.ts`
- `codex-headless/src/transcript/JsonlTailer.ts`

- [ ] Define the rule:
  - if proxy is enabled and healthy, proxy owns live semantics
  - otherwise rollout owns live semantics
- [ ] Implement a session-level mode selection so both paths do not co-own the same live turn.
- [ ] Let the non-owner still emit debug or reconciliation signals, but not semantic mutations.

**Success criteria:**
- Codex no longer has proxy and rollout both acting as live semantic writers.

### Task 9. Constrain Codex screen fallback to pre-authoritative bootstrapping only

**Files:**
- `codex-headless/src/CodexHeadless.ts`
- `codex-headless/src/parsers/ScreenParser.ts`

- [ ] Permit screen fallback only while no owner exists.
- [ ] As soon as proxy or rollout claims ownership:
  - finalize screen fallback turn
  - drop future screen semantic mutations
- [ ] Keep screen-based approval/trust/activity flows intact.

**Success criteria:**
- Codex screen content can no longer fight proxy or rollout content.

### Task 10. Make CodexResponsesAdapter respect orchestrator ownership

**Files:**
- `codex-headless/src/proxy/CodexResponsesAdapter.ts`

- [ ] Keep the single-active-flow gating from the flicker fix.
- [ ] Add a hard guard before every semantic publish:
  - only publish if orchestrator ownership accepts this `turnId`
- [ ] Route ignored frames into debug/proxy stats only.

**Success criteria:**
- Proxy adapter cannot mutate semantic state once ownership is denied.

## Phase 5. Reconciliation instead of co-authoring

### Task 11. Add explicit reconciliation events

**Files:**
- `claude-code-headless/src/channels/types.ts`
- `codex-headless/src/channels/types.ts`
- `claude-code-headless/src/ClaudeCodeHeadless.ts`
- `codex-headless/src/CodexHeadless.ts`

- [ ] Add events for:
  - `turn_reconciled`
  - `turn_durably_committed`
  - `turn_commit_mismatch`
- [ ] Use these events to correlate live semantic turns with transcript/rollout durability.
- [ ] Do not mutate the active live turn during reconciliation.

**Success criteria:**
- Durable transcript confirmation happens without reopening or rewriting the live turn.

### Task 12. Keep overlay channels independent

**Files:**
- `claude-code-headless/src/parsers/*.ts`
- `codex-headless/src/parsers/*.ts`
- `claude-code-headless/src/channels/ScreenChannel.ts`
- `codex-headless/src/channels/ScreenChannel.ts`

- [ ] Audit approval/trust/slash/resume/compaction flows.
- [ ] Ensure they only emit overlay state, not assistant content mutations.
- [ ] Preserve current overlay UX behavior.

**Success criteria:**
- Screen/UI parsing remains useful without leaking back into content ownership.

## Phase 6. Renderer contract cleanup

### Task 13. Narrow the renderer contract to one resolved live turn

**Files:**
- `src/renderer/src/tiles/workspaceState.ts`
- `src/renderer/src/tiles/workspaceStore.ts`
- `src/renderer/src/feed/Feed.tsx`

- [ ] Update runtime state so renderer receives:
  - committed history
  - optional current live turn
  - reconciliation metadata
- [ ] Remove assumptions that multiple producers may still be racing.
- [ ] Ensure feed rendering never appends a stale live turn after committed transcript has superseded it.

**Success criteria:**
- Feed consumes a resolved model instead of deduping headless ambiguity.

### Task 14. Remove provider-specific semantic healing from the renderer reducer

**Files:**
- `src/renderer/src/tiles/workspaceStore.ts`

- [ ] Simplify `foldSemanticEvent`.
- [ ] Delete provider-specific turn mismatch policy that only exists because headless ownership is ambiguous.
- [ ] Keep the reducer as a straightforward fold over valid lifecycle events.

**Success criteria:**
- Renderer reducer becomes smaller and less policy-heavy.

## Phase 7. Verification and rollout

### Task 15. Add integration traces for source ownership transitions

**Files:**
- `claude-code-headless/src/testing/*`
- `codex-headless/src/testing/*`

- [ ] Add deterministic traces covering:
  - screen fallback before proxy
  - proxy claiming ownership
  - rollout claiming ownership
  - late committed confirmation
  - concurrent proxy flow ignored
  - illegal stale-source delta dropped

**Success criteria:**
- Ownership transitions are testable without the full renderer.

### Task 16. Validate with rendering harness and real sessions

**Files:**
- `testing/rendering/*`
- app runtime integration points

- [ ] Verify Claude:
  - proxy live text
  - tool streaming
  - transcript commit
  - no duplicate live tail
- [ ] Verify Codex:
  - proxy live blocks
  - rollout-only fallback mode
  - no block flicker
  - no screen-derived prose in main feed

**Success criteria:**
- Headless ownership bugs are fixed before renderer polish work resumes.

---

## Recommended implementation order

1. Strict `SemanticChannel` behavior and tests
2. Shared `liveOwner` model in both headless orchestrators
3. Claude proxy ownership enforcement
4. Claude committed/screen demotion to reconciliation/overlay
5. Codex single authority selection: proxy vs rollout
6. Codex screen demotion to bootstrap-only overlay
7. Reconciliation events
8. Renderer contract cleanup
9. End-to-end verification

---

## Non-goals

- Reworking visual styling
- Rewriting tool row presentation
- Changing transcript file formats
- Removing screen parsing entirely
- Solving every historical renderer bug before ownership is fixed upstream

---

## Expected payoff

If this plan is implemented correctly:

- Claude and Codex streaming stop fighting themselves
- screen parsing remains useful without corrupting assistant content
- committed transcript stays durable without mutating the live turn
- `workspaceStore` and `Feed` can become much simpler
- future rendering bugs become local and debuggable instead of cross-layer race conditions
