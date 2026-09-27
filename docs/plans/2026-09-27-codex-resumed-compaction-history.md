# A resumed rollout that starts with `compacted` shows its retained prompts (#1393)

Depends on #1386, which maps `compacted` at all.

## Evidence (local corpus)
- **The affected files.** 82 rollouts, 68 sessions, 58 of them with no other local file, have a `compacted` line before any `response_item` or `event_msg`. Its `replacement_history` retained user prompts are the only copy of that earlier conversation in the file.
- **Elsewhere the retained prompts duplicate.** 33,443 of 37,724 retained user items have an exact earlier match. That is why #1386 does not replay `replacement_history`.
- **`session_meta` marks the file head.** Across 2,579 local rollouts, **0** have a `session_meta` after a conversation record: it only ever appears at a file's head.

## Change
- **`createCodexTranscriptEntryMapper` tracks the file head.** The state is set by `session_meta` and cleared by the first `response_item` or `event_msg`.
- **A `compacted` line at the head** also maps its retained user prompts, through the new `mapCodexRetainedUserHistory`, placed before the boundary.
  - The prompts go through the same synthetic filter as ordinary `response_item` user rows: the AGENTS.md preamble, environment context and subagent notifications are dropped.
  - Developer items and the encrypted `compaction` item are not conversation.
  - They carry the compacted line's timestamp and stable `:retained:<i>` uuids.
- **No loader or shared-type change.** A page or live burst that starts mid-file never has a `session_meta` first, so it can never enter the head state. Initial history, an older page that reaches the file start, and a preview from the file start all get the prompts.

## Tests (`resumedHeadCompaction.test.ts`, the real mapper)
Fixture: `testing/fixtures/rendering-shapes/codex/compaction/resumed-head-compacted.json`, the real head of a 0.145.0 rollout that starts with `compacted`. Text is redacted to the same length, except the two bootstrap marker prefixes the filter recognises.
1. **The resumed head** gives 7 user prompts (8 retained, minus the bootstrap) and then the boundary, all at the compacted line's time. Red on #1386's head.
2. **The same page without its `session_meta`** (a mid-file page) gives only the boundary.
3. **A compaction after a conversation record in the same file** gives only that record and the boundary.

Mutations: never mapping retained prompts, never leaving the head state, and treating any non-conversation line as the head each fail a test.

## Not done
The retained prompts render as ordinary user rows. There is no "retained" styling; a visual marker would be a separate UX decision.
