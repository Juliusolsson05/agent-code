# TLDR and Goal stores evict instead of filling up (#1277)

## Problem
`TldrStore.update()` throws `TLDR storage is full.` for a new identity once the store holds `MAX_RECORDS` (10,000). Nothing ever deletes a record, and the store is never told an agent closed. The owner's live store holds 412 TLDR and 374 Goal records after 15 days (~27 new identities a day), so it reaches the wall in about a year. From then on, every NEW agent's `tldr_update` and `goal_set` fails for good, while agents that already have a record keep working. Both stores are instances of this class (`src/main/index.ts`), so both fail.

## Evidence
- `src/main/tldr/TldrStore.ts` has `MAX_RECORDS = 10_000` and the throw in `update()`. `load()` refuses a file with more records than that.
- The owner's store (`~/.config/agent-code/{tldr,goal}.json`, 2026-09-26): 412 and 374 records, oldest `updatedAt` 2026-09-12 and 2026-09-13.
- The committed fixture `testing/fixtures/tldr-store/real-records-2026-09-25.json` supplies real record shapes for the test.

## Decisions (defaults)
1. **Evict the least recently written record, in the same atomic write that adds the new one.** "Written" is the later of `updatedAt` and `completedAt`, because a completion is a write and a just-completed goal is exactly what the close menu shows. The store drops exactly enough records to fit, which is one.
2. **An evicted identity's revision is remembered in memory** (the same map as set-aside records, #1247 review A). If that identity reports again in the same run, it continues above its old revision, so a reader that still holds the old record does not discard the new one as stale. Across a restart, readers start empty too, so nothing is lost there.
3. **History files are left alone.** They have their own cap (`MAX_HISTORY_FILES`, oldest mtime first), and a user reading an old agent's timeline should still see it.
4. **No change event is sent for an eviction.** The evicted record is the least recently written of 10,000; no pane on screen relies on it, and `TldrUpdate` has no removal shape.
5. **`load()` still refuses a file over the cap.** The store can no longer write one, so a file over it is damage (or a newer build's larger cap). Refusing preserves it, which is the file's existing rule.

## Tests (fail-first)
In `TldrStore.system.test.ts`, on records built from the real fixture:
- A store at exactly `MAX_RECORDS` accepts a new identity's report. It evicts the least recently written record, keeps the rest, and stays at `MAX_RECORDS` on disk.
- A completed goal whose `completedAt` is recent is not the one evicted, even though its `updatedAt` is oldest.
- An evicted identity that reports again continues above its evicted revision.
