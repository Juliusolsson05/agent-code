# Codex text ghosts are never superseded (#1231)

## Evidence (verified 2026-09-27)
- **The mismatch.** Codex ghosts are keyed by the live semantic turn id, which is the proxy response id (`resp_…`, `ghostsFromSemanticTurn` → `ghostUuid(turn.turnId, blockIndex)`).
  - `reconcileUpstream` matches Codex entries on `codexTurnId`, but the mapper stamps that from `turn_context.turn_id`, a rollout UUID (`providers/codex/renderer/transcript/mapper.ts`, `stampCodexTurnId`). It never equals a `resp_…` id, so that branch never matches.
  - Text blocks have no tool id for the fallback, so every Codex text ghost orphans after 30 s. It stays hidden only by render rules 3/4 in `selectMergedEntries`.
- **The two ids that do agree.** Every rollout `response_item` carries the provider item id (`msg_…`, `rs_…`, `ctc_…`, `fc_…`), and the live block already has it: `CodexResponsesAdapter` emits `itemId` on `block_started`, and `foldEvent` keeps it on `SemanticLiveBlock.itemId`.
  - Checked on 6 real Agent Code 0.157.1 sessions (proxy dumps against their rollouts, 2026-09-27): every `msg_…` id seen on the proxy stream, 45 of 45, appears verbatim in the rollout.
- **The other route and why not.** `token_usage_record` rows carry `{turn_id, response_id}` after each response's items, which would allow a retroactive match by response. The item id is exact per block and needs no lookahead, so it is the route taken (issue comment, route 2).

## Change
- `mapCodexRolloutToFeedEntries` stamps `codexItemId` (the rollout item's `payload.id`) on every entry it maps from a `response_item`. This is an Agent Code-local field, like `codexTurnId`.
- `ghostContextForBlock` records the block's `itemId` in the ghost's `context`, atp's free-form slot. No package change is needed.
- `reconcileUpstream` supersedes a ghost when `context.itemId === entry.codexItemId`.
- The `codexTurnId === ghost.turnId` branch compares a rollout UUID with a response id, so it can never match. It is removed, and the stale comments that claim the mapper stamps the response id are corrected.

## Tests
A recorded pair from a real 0.157.1 session: the response's SSE frames for one assistant message (`response.created` id, `output_item.added`/`delta`/`done`) and the rollout `response_item` for the same `msg_…` id. The chain:
1. The frames drive the real `CodexResponsesAdapter` (codex-headless adapter harness) and the real `foldSemanticEvent`.
2. The ghost is minted by `ghostsFromSemanticTurn`.
3. The rollout record goes through the real mapper and `reconcileUpstream`.

The ghost must be superseded by that entry's uuid. It is red on main. A second rollout message with a different id must NOT supersede it.

## Out of scope
- Reasoning ghosts get the same match for free, where a mapped entry exists.
- The `token_usage_record` route (parser#38 tracks the type itself).
