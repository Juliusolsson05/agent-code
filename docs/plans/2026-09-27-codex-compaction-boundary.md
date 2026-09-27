# Codex compaction never renders (#1289)

## Evidence (verified 2026-09-27 on the local corpus, about 1,500 `compacted` lines)
1. **The branch never runs.** `mapCodexRolloutToFeedEntries` returns early when `payload.type` is not a string. A `compacted` line's payload has no `type`, so the `entry.type === 'compacted'` branch never runs and Codex compaction never renders.
2. **The boundary has no timestamp.** The boundary entry is built without one, and `rendering/model/order.ts` sorts timestamp-less rows to the end of their phase. So enabling the branch as-is would paint "Conversation compacted" at the bottom of the feed, not where it happened.
3. **`replacement_history` is not new conversation.** It is the context Codex retains across the compaction: developer instructions, the AGENTS.md block, earlier user prompts and (0.155+) a `compaction` item whose summary is `encrypted_content` (13–23 KB). Mapping it repaints prompts already in the feed (#1289: 17,326 of 20,343 sampled replacement messages duplicate an earlier user message).
4. **The summary `message` is empty in every 0.15x rollout.** Only 56 of about 1,500 compactions carry readable text, all from older CLIs.
5. **The boundary stores the whole payload as `compactMetadata`.** That is `replacement_history`, the retained user prompts, resume metadata and the encrypted blob, kept on a feed entry and in every debug bundle, although nothing reads more than identity.

## Change
- Handle `compacted` before the `payload.type` guard.
- The boundary carries the line's timestamp, so it sorts where compaction happened.
- `replacement_history` is never mapped. The summary entry is emitted only when `message` is non-empty (older CLIs).
- **No `compactMetadata`.** Nothing in the app reads it for Codex, and a varying metadata object also made every boundary a different rendering shape.
- Catalog: add Codex durable shapes for the boundary and the summary. They are the same shared.compaction dispositions Claude's entries have, pinned by curated fixtures.

## Tests
Two real `compacted` lines: a 0.157.0 one (empty message, `compaction` item) and an older one with a readable message. Texts are redacted at equal length; the structure and keys are verbatim.
- Both map to a timestamped boundary.
- Only the older one also maps to a summary.
- No replacement-history entry is emitted.
- The boundary carries no retained history.
- Red on main, where both map to `[]`.
- The dispatcher renders the boundary through `shared.compaction`, and the catalog classifies it `known-claimed`.
