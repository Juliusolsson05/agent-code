# Code drift report: 2026-05-22 docs vs tree @ abf4b8c (2026-07-06)
1. renderModel.ts: union unchanged (5 types); + entryOrdinal, order.source. Sort as
   documented. committedClaudeMessageTurnIds STILL claude-named but opencode committed
   entries also carry message.id => they populate the "claude" set and get whole-turn
   suppression — naming/semantics mismatch to resolve.
2. foldEvent.ts: NOW policy-driven (SemanticFoldPolicy 5 knobs via registry; 2026-07-06).
   BUT yield hatches still proxy-string-hardcoded (isCompletedProxyTurnReadyToYield,
   isEmptyNonProxyShellTurn, isTerminalProxyBlock) + tool_started codex literals —
   generalization HALF-DONE.
3. ghosts: five-rule predicate + cap 200 intact. OPENCODE MINTS GHOSTS (not gated) but
   reconcileUpstream has NO opencode supersede key (mapper puts no message.id inside
   entry.message; uuid=messageId only) => opencode text ghosts only die via TTL/rule-3.
   DECIDE: gate opencode ghosting or add supersede key.
4. Live rows STILL bypass registry: BlockRow hardcoded kind/toolName dispatch imports
   Claude/Codex rows directly; committed Block.tsx uses registry renderToolUse. Opencode
   todowrite row only fires for COMMITTED rows.
5. useIpcSubscriptions: turn-based phase bridge (:972-1028); capability-gated echo
   reconcile (:1525-1538); routing by SESSION kind + codex shape-sniff fallback + shadow
   mismatch counter (:1438-1513); jsonl_provider_conflict quarantine drops foreign
   bursts (:1273-1330); queue idle-clear at 4 sites w/ 2000ms stability backstop.
6. queueInvariants: renamed shouldClearIdleQueuedMessages, usesOptimisticUserEcho gate,
   + providerReportsPendingQueue future hook.
7. opencode: message-fan-out mapper ({info,parts} => ConversationEntry + per-tool user
   tool_result; uuid=messageId; tool ids=callID; completed-gate); fold policy
   allowReplaceOfLiveTurn=false (flipped after 87f0eeef — concurrent messages land via
   committed assembly); rows dispatch = todowrite only.
8. CONDITIONS REGRESSION FIXED: ClaudeCodeHeadless now publishes unified conditions
   snapshots (publishConditionSnapshot, screen-tick). Renderer single-channel holds.
9. All 2026-07-06 ownership-changing comments enumerated (fold policy, block-loss site,
   queue rename, opencode policy flip, phase bridge, echo gate, todowrite row).
