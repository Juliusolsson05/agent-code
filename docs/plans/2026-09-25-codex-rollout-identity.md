# Codex rollout entries need a unique identity (#1288)

## Evidence
- `rollout.ts:260-262` builds the uuid as `${timestamp}:${payload.id ?? call_id ?? payload.type}`, and `historyLoader.ts` `extractCodexHistoryMarker` duplicates the rule in main.
- A `function_call` and its `function_call_output` in the same millisecond share `ts:call_id`. Real example: 2026-04-28 rollout, `exec_command df -h .` and its output, both at 16:36:01.649Z.
- Id-less items (`message`, `event_msg` types) in the same millisecond share `ts:<type>`. Real example: 2026-04-16 14:34:49.436Z, a user message and an assistant message.
- `committedRecords.ts:100-111` admits by uuid and drops the second one, permanently, on the live, tail and older-page paths.
- Owner corpus: 270 of 2,212 rollouts have 1,232 colliding keys among visible items, 4 of those rollouts from 2026-09.

## Change
One shared `codexRolloutIdentity(entry)` in `src/shared/codex/`, used by the renderer uuid, the renderer marker and main's marker, so the three cannot drift:
- a payload `id` stays `ts:id` (already unique);
- a `call_id` item stays `ts:call_id`, and its `*_output` becomes `ts:call_id:output`;
- anything identified only by its type gets `ts:type:<fnv1a of the payload JSON>`, so two different items differ and the same line re-read still dedupes;
- a missing timestamp is `''`, not `Date.now()`, so the identity is stable across reads.

Markers are never persisted (`historyLoader.ts` header). Offsets anchor older pages, so the format change needs no migration.

## Tests
Real, minimal, redacted shapes from those two rollouts, driven through the real mapper and `admitMappedEntries`. Both items must be admitted. This is red on main.
