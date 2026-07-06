# codex-rewrite-render + design docs extraction (2026-07-06)
Key net-new items (full analysis in session; plan carries the decisions):
- feed-render-item-plan: "no visible row ordered by accidental JSX branch position";
  FeedRenderOrder {sequence, timeMs(diagnostic), source}; ORDERING LAW:
  semantic-history.endedAt < user.timestamp => history BEFORE prompt; current after.
  Stale history is REORDERED not suppressed (data-loss risk) UNLESS committed owns it.
  Rejected: one-array-sort-by-timestamp (no shared stable ids); submit-time queue gate
  (#252 — handoff re-runs bug + one-frame race). Timestamp trust: committed ts=durable,
  semantic startedAt/endedAt=local receipt, channel ts=diagnostic. 5-way tiebreak.
  Hazards: LazyEntry eager/lazy from ENTRY ORDINAL; autoscroll off item-list tail
  signature; work item carries hint inputs explicitly; old script test asserted the
  WRONG bucket order. Step 4 (queue into items) NEVER SHIPPED.
- first-principles: debug and paint from same decision (semanticTurnHasRenderableContent
  before model rows); ghosts are a co-equal owner (item plan omitted them!).
- headless-channel-model: at most one live semantic owner; owner transitions explicit
  (finalize shadow turn; claude reconciling state after proxy turn_completed);
  promotion-on-first-chunk; response.completed releases slot pre-socket-end; DRIFT:
  codex screen still publishes coarse phase onto authoritative channel when owner not
  proxy; NAMED BUG: rollout agent_message_delta soft-open never startTurns (dropped as
  delta_mismatched_turn). 10 Feed Invariants list incl. never prefix/fuzzy dedupe.
- renderer-runtime-ingestion: onSessionJsonlEntries is ONLY committed path; singular
  handler = regression; bootstrap quiet 150ms repairs stale flags; loadOlderHistory
  never advances lastJsonlEntryAt; suppress-vs-reorder discriminator = committed owns.
- feed-ui-rendering: Feed ALREADY renders one ordered items list (#256 shipped);
  FeedRenderUnit BLOCK-level proposal + suppressedUnits[] w/ reasons + pure
  buildFeedRenderPlan => THE ledger shape; keys from artifact identity; ingest-time
  synthetic ids; TextProse vs StreamingProse split load-bearing (gfm vs gfm+breaks +
  open-fence split); collapsed_activity returns null while running (intentional).
- submit-queue-debug: prompt ingress state machine typed→optimistic|queued→committed;
  claude NEVER optimistic by default; RenderOwnershipDebug ownership_decision schema
  (candidate/decision/evidence; slot + source enums) = ledger debug schema.
- upstream-codex: COPY delta-vs-completion reconciliation (deltas extend live unit;
  completion finalizes or creates-only-if-no-deltas); turn lifecycle off TurnStarted/
  Complete + item ids never resp_*; flush stream before tool rows; reasoning=status;
  queued input = UI lane (endorses queue-as-lane); replay≠live (no correlation side
  effects; Event.id None). REJECT latest-text-wins + render-every-event.
- ghost-system: Phase 3 = ghost as ONLY live path + ordered insertion in
  mergeWithUpstream + DELETE SemanticStreamingTurn — never shipped; ledger with ordered
  view model IS Phase 3 done right; delete StreamingTurn + rule 3 TOGETHER. NEVER ghost
  tool outputs (fabricates model output). Reconciliation matchers provider-aware.
- conditions-system: registry outlet at-most-one-live-overlay; priority-not-insertion-
  order lesson; conditions are overlay owners, never feed rows.
