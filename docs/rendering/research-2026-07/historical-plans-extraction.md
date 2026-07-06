# Historical Plan Docs Extraction (2026-07-06)

Source: full reads of 2026-05-07 ghost docs (x2), 2026-04-17 gating+flicker docs,
2026-04-15 screen-removal, 2026-04-20 rendering-fixes + dup-text, 2026-04-18
feed-debug-stream, 2026-06-14 subagent-fleet. Feeds the consolidated rewrite plan.

## Failed-fix history (permanent fixtures, with mechanics)
- 10e4fc5 (04-20): hide non-current ghosts. Origin 69e61aa3: stale old-turn ghost
  below newer committed rows (tail-append inversion). Killed orphan fallback entirely.
- 686b94e (04-24): render orphans after TTL(3s). Did not distinguish WHY a ghost
  orphans → 7+ sidecar fragments parked at bottom permanently.
- 2a83978 (05-07): shape filter (assistant, 1 text block, ≤200ch). Bundle
  2026-05-07T08-26-35-212-5d948ab5: 7 orphans, 0/23 flows demoted; sidecars 12-41ch
  188-602ms vs real ≥76ch ≥808ms. Defeated by longer predict-next-prompt; hides "Done."
- fix/hide-orphan-ghost-tail (05-07): hide all again = 10e4fc5 redux.
- predict-next-prompt defeats isSidecarFlow: full history → messageCount>3 breaks
  budget signal; system prompt not in 4-entry prefix list.

## Ghost predicate — THE CONTRADICTION RESOLVED
findings §11.4 said delete rule 5 (timestamp alone suffices). The LATER predicate
plan OVERTURNED it: tail-sidecar case (real commit t=100, sidecar t=105, user walks
away, no later JSONL → updatedAt>tail renders garbage) is the DOMINANT production
failure. BOTH rules stay. §10 case table + 10-case matrix (incl. tool_use-orphan
renders even short; lastJsonlEntryAt===null falls through to shape rule) = fixtures.
Constants: T_OLD_JSONL=1_700_000_000_000, ±5000 offsets; sidecar cap 200 (max sidecar
41ch vs min real 76ch).

## Ghost invariants not in the dump
1. Deterministic uuid g-<turnId>-<blockIndex> is load-bearing (append-only LWW reduce).
2. lastJsonlEntryAt null-not-zero (0 sentinel renders ghosts on fresh sessions).
3. Compare entry.timestamp (producer wall-clock), never Date.now() (resume skew).
4. history.ts (older pagination) must NEVER stamp lastJsonlEntryAt.
5. selectMergedEntries returns entries BY IDENTITY when no ghost survives.
6. Reference-stability across ALL reducers = load-bearing (setRuntimes cascade bug).
7. TTL 30s semantic = "JSONL had its chance", not "paint fast"; 5000-line Read
   produces proxy-quiet window that 3s TTL mis-orphaned.
8. turn_completed→JSONL ~100ms race: only rule 2 (TTL) prevents flicker.
9. Ghost is NOT crash-recovery fiction: predicate fix is what MAKES it recovery.
10. Codex entry.timestamp coverage unverified; degrade to no-update not NaN.
11. Accepted trade: short crashed "Done." turn invisibly lost (rule 5). Documented.

## foldEvent provider-gating origin (04-17 docs)
0/1/0/1 flicker: THREE producers (proxy resp_*, rollout turn_id, screen live-<ts>)
into single-slot SemanticChannel; screen applyDelta at 60Hz swaps slot & resets
blocks. Codex lacked Claude's activeStreamingFlowId gate (promotion-on-first-chunk,
flow_ignored for concurrents). Fix = producer gate AND strict reducer (keep BOTH).
Claude regression from strictness: Claude pins currentTurn across turn boundaries
(hasPendingSemanticTools; tool_result arrives in NEXT user entry) → next msg_*
turn_started dropped → blank live view. Resolution: provider fork — Claude
auto-replace/archive, Codex drop; default 'claude' when meta absent. Strand C:
never gate semanticTurn render on derived sessionStatus.
Invariants: source promotion via finishTurn→startTurn + source_changed; screen must
check channel's active turn not own field; tool_started gated though Codex-only.

## Screen-removal decision (04-15)
currentTurn.source ∈ {proxy, rollout} is a TRUST INVARIANT; foldEvent must refuse
source:'screen' into content. Screen stays for approvals/trust/activity/baseline.
Product decision: Codex agent-mode hard-fails without proxy.

## 04-20 defect cluster (fixtures)
- resume tool_result flood before session_started (jsonl bridge at startup)
- 37-ghost bootstrap flash (superseded-on-disk promoted; → trustSupersededFlag,
  mutually exclusive w/ keepSupersededGhosts; atp+app ship as pair)
- live-turn null-flip mid-turn (ghost short-circuit vs currentTurn)
- double RENDER per transition (reference churn)
- bootstrap ORDER bug: JSONL lands before disk ghosts → post-bootstrap reconcile
  pass over current.entries + persist supersede records
- 250ms readyForLiveBridge quiet-window = only judgment call; replaceable by
  bootstrap-complete signal

## Claude dup-text latent defects (VERIFY in drift report)
1. Committed tool_result bridge forwards parent-entry uuid as turnId → reducer
   drops → hasPendingSemanticTools stays true → duplicate text until next turn.
   Fix: drop turnId from bridged event; match by globally-unique toolUseId; on
   mismatch record tool_result_turn_mismatch and fall through (soft guard).
2. screen_update churn: 13,593 events ~97% chrome-tick identical; tier-2 detector
   commits strings but skips feed-debug append.
Regression fixture: after turn_completed + committed tool_result, currentTurn
is null within one tick.

## Feed-debug design drift (04-18)
Plan vocabulary STATE|JSONL|SEM|MAP|RENDER → shipped GHOST for MAP. Persistence
drifted IN (was a non-goal). Never-shipped payoffs = rewrite's diagnostic backbone:
single deriveFeedRenderItems decision point; visible-list diffs before/after/
added/removed/moved; invariant WARNINGS (user-row-vanishes-no-replacement,
dual-render same turn, key-changed-source-same, unexplained shrink). Log at
DECISION boundaries not paint; delta rollup; identity keys in every payload.

## Subagent fleet (06-14) — surface reservation
toolUseId = first-class owner key (meta.toolUseId ↔ Task block.id). Main-process
SubAgentWatcher (fs.watch, 120ms coalesce, complete-lines only); IPC
session:sub-agents pushes Record<toolUseId, SubAgentState>; runtime.subAgents
with reference-equal bail. Claude-only Task intercept in Block.tsx.
SUBAGENT_TOOL_CALLS_MAX=40 + droppedToolCalls. Done-derivation deferred (v1
all-running; upgrade = parent tool_result lookup). Missing toolUseId → skip.

## Plan-changing items
1. Ghost predicate = BOTH rules 4+5; later doc wins over findings §11.4.
2. Full 5-rule predicate + 10-case matrix + accepted-trade documented = fixtures.
3. Provider fork in fold is a hard requirement (Claude auto-replace / Codex drop).
4. Flicker defense is producer AND consumer — keep both layers.
5. source ∈ {proxy,rollout} trust invariant; screen never content.
6. Reference-stability structurally enforced, not conventional.
7. Bootstrap order + trustSupersededFlag mandatory for resume.
8. Verify dup-text defects shipped; carry the one-tick fixture regardless.
9. Ledger = the "one deterministic decision point" 04-18 wanted; wire its WARNINGs.
10. Reserve toolUseId subagent surface (#178/#341).
