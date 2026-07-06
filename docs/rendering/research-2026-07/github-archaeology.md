# GitHub Archaeology for the Rendering Rewrite (extracted 2026-07-06)

Source: #172 comments 2-7, #159 all comments, PR bodies #184/#256/#262/#165/#252/#263/#170/#194/#197.
Feeds the consolidated rewrite plan. Key extractions verbatim-adjacent.

## #172 comment 5 (2026-05-20) — REOPENED, acceptance criteria REWRITTEN
PR #184 closed #172 prematurely (first-pass selector, bucket model, separate JSX planes).
Buried-prompt reproduced post-#184. New acceptance criteria (supersede everything):
1. selector returns single ordered visibleItems: FeedRenderItem[]
2. Feed.tsx maps that list once — no separate planes
3. each item carries owner metadata: committed | semantic-history | semantic-current | optimistic-submit | queue-strip | ghost | work | empty
4. render debug logs final DOM order + owner/suppression reasons
5. regression tests assert FINAL ORDER, not row existence
6. #252 queueing = tactical guard only; renderer must not rely on queueing to compensate for non-chronological planes

## #172 comment 6 — the ordering rule + queue-handoff race
TRUE CHRONOLOGICAL MERGE, not plane concatenation:
- stale semantic history ended BEFORE a newer user prompt renders BEFORE that prompt
- live semantic started AFTER the prompt renders AFTER it
Queue-handoff race: committed user row replaces queued prompt → can re-bury if semantic
history still renderable. One-frame race: optimistic appended, semantic history becomes
renderable a frame later → re-buried.

## #172 comment 7 (2026-06-22) — #339 is the open tail
Three evidence shapes: prompt stuck in queuedMessages while agent active; queue empty but
prompt exists only in screen tail; committed user row missing/delayed/filtered → prompt
never gets durable feed owner. Rewrite must give a submitted prompt a durable owner even
when no committed row ever arrives.

## #172 comments 2-4 — net-new invariants
- ONE bulk committed-ingestion path; multiple handlers break dedupe/supersedure
- committed-channel ownership = lineage proof, never cwd/latest-file
- current render order (to replace): committed → semantic history → semantic current → work → sentinel
- required per-item debug: stable logical id, kind, candidate owners, selected owner,
  suppressed owners + reasons, handoff target, React key, DOM presence; flow_selected/
  flow_ignored in render trace
- queued follow-ups intentionally NOT feed rows ("phantom future user rows" duplicate later)
- optimistic reconciliation by marker+text, never tail position (tool-result user rows
  can commit before the real prompt)
- a submitted prompt has exactly one visible owner: optimistic | queued | committed

## #159 — full root-cause chain (Codex feed clearing)
1. entries frozen at 53-entry bootstrap; jsonl_entries fired once; tailer silent after bootstrap
2. ROOT: resume tailer pinned to rollout that Codex FORKED away from; fallback watcher only
   covered miss-case, not hit-but-forked; "first new rollout wins" unsafe under orchestration
3. Ghost could NOT save it: Phase 3 never built; 30s TTL = "give up on JSONL" timer not
   "paint fallback fast"; rule 5 hides short messages; ghost correctness model ASSUMES
   JSONL eventually arrives — here it arrives NEVER
4. Precise reframe: rollout IDENTITY bug — bootstrap from plausible same-cwd file while
   live process writes elsewhere; fix = provider session id + session_meta.id match +
   lineage overlap; fail closed
5. Fix split: codex-headless#9 (cwd + copied-history lineage gating) = real fix;
   renderer semantic-history bridge (#165) = secondary mitigation. "Not yet exercised
   against a live Codex resume/fork" at merge time.

## PR bodies — decisions + loose threads
- #256 (05-21): shipped single ordered FeedRenderItem[] INCLUDING queued prompts as items;
  REMOVED the separate QueueStrip plane. (NOTE: docs dated 05-22 + practical plan say queue
  went back composer-adjacent after #263 — verify in drift report which is true TODAY.)
- #262: killed bucket compat fields; FeedCommittedProjection.visibleEntries still exists
  (different concept — don't confuse).
- #165: semantic history = bounded FULL SemanticLiveTurn snapshots; Codex suppression
  per-block/item because items commit one at a time sharing turn ids; ended pending-tool
  turn replaceable. Test plan never verified live.
- #252: Codex-only idle queue invariant; sanctioned workaround to supersede.
- #263: Vitest ground zero; all scripts/test-*.ts DELETED; old npm test:* names dead.
- #170: exact/normalized committed-text suppression for resp_* vs rollout id split.
- #194: itemId-based committed ownership for native activity (web search); empty finalized
  reasoning/thinking not renderable. #193 deferred (resume lineage edge).
- #197: fresh rollout = prompt-owned candidate scoring, fails closed.

## Open issue map (rendering)
#172 (umbrella, OPEN), #339 (prompt ownership tail), #338/#341/#342/#343/#344/#345/#346
(2026-06-22 cluster), #290 (Claude analog of #159), #193, #183 (test mandate), #178/#179
(subagent/background surfaces), #185 (queue rendering), #375 (byte windowing).

## Plan-changing items (10)
1. #172 comment-5 criteria are THE bar (ordered items, owner tags, order-asserting tests)
2. Ordering = chronological merge rule from comment 6
3. #256/#262 already shipped item-list model — rewrite starts from items, not buckets
4. Old test script names dead; Vitest projects are the base
5. Dead committed channel is an IN-SCOPE state; ledger needs owner+diagnostic for it
   (ghost model assumes JSONL arrives; #159/#290 prove it may never)
6. Queue workaround to supersede; queue-handoff race must have a fixture
7. #339 closes via the rewrite: durable owner for submitted prompt sans committed row
8. Single bulk ingestion + identity-stable selector are load-bearing constraints
9. Codex suppression per-item/itemId/exact-text only; never whole-turn
10. #338-#346 cluster = same disease new surfaces; ledger reasons must explain them
