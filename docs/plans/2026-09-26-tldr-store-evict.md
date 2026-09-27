# TLDR and Goal stores evict instead of filling up (#1277)

## Problem
`TldrStore.update()` throws `TLDR storage is full.` for a new identity once the store holds `MAX_RECORDS` (10,000). Nothing ever deletes a record, and the store is never told an agent closed. The owner's live store holds 412 TLDR and 374 Goal records after 15 days (~27 new identities a day), so it reaches the wall in about a year. From then on, every NEW agent's `tldr_update` and `goal_set` fails for good, while agents that already have a record keep working. Both stores are instances of this class (`src/main/index.ts`), so both fail.

## Evidence
- `src/main/tldr/TldrStore.ts` has `MAX_RECORDS = 10_000` and the throw in `update()`. `load()` refuses a file with more records than that.
- The owner's store (`~/.config/agent-code/{tldr,goal}.json`, 2026-09-26): 412 and 374 records, oldest `updatedAt` 2026-09-12 and 2026-09-13.
- The committed fixture `testing/fixtures/tldr-store/real-records-2026-09-25.json` supplies real record shapes for the test.

## Decisions (defaults)
1. **Evict the least recently written record that nothing is using, in the same atomic write that adds the new one.** (Revised after review; see below.) "Written" is the later of `updatedAt` and `completedAt`, because a completion is a write and a just-completed goal is exactly what the close menu shows. The store drops exactly enough records to fit, which is one.
2. **An evicted identity's revision is remembered in memory** (the same map as set-aside records, #1247 review A). If that identity reports again in the same run, it continues above its old revision, so a reader that still holds the old record does not discard the new one as stale. Across a restart, readers start empty too, so nothing is lost there.
3. **History files are left alone.** They have their own cap (`MAX_HISTORY_FILES`, oldest mtime first), and a user reading an old agent's timeline should still see it.
4. **No change event is sent for an eviction.** The evicted record is the least recently written of 10,000; no pane on screen relies on it, and `TldrUpdate` has no removal shape.
5. **`load()` still refuses a file over the cap.** The store can no longer write one, so a file over it is damage (or a newer build's larger cap). Refusing preserves it, which is the file's existing rule.

## Tests (fail-first)
In `TldrStore.system.test.ts`, on records built from the real fixture:
- A store at exactly `MAX_RECORDS` accepts a new identity's report. It evicts the least recently written record, keeps the rest, and stays at `MAX_RECORDS` on disk.
- A completed goal whose `completedAt` is recent is not the one evicted, even though its `updatedAt` is oldest.
- An evicted identity that reports again continues above its evicted revision.

## Review round 1 (#1328): the eviction policy changed
All three reviewers (and steering q45) found that age alone can evict a goal that is still active. A goal is set once per task, so the oldest goal can belong to a running agent. After eviction, that agent's `goal_complete` failed, and views that had already read the record kept showing it: the peek, Agent Activity, and a tickable row in Close Completed Agents. No removal event exists.

**Policy (final).** An identity is **in use** while any window's persisted workspace names it (`projectWorkspace`, the same projection Agent Activity and remote use), or while a registered, unrevoked MCP session reports as it (`BuiltInMcpHttpHost.liveTldrIdentities`, which covers an agent spawned since the last autosave). In-use identities are never evicted.
- Every renderer view reads identities of workspace sessions only, so an evicted record is one no view shows. That is why no removal event or renderer change is needed.
- When no candidate exists, or in-use is unknown (the workspace file has not opened yet), the store refuses with `<label> storage is full.` and writes nothing: ambiguity fails closed (q40). This also fixes the Goal store's error, which used to say "TLDR".

**Declined: a renderer removal path.** With the in-use rule, no mounted view can hold an evicted identity, because views are keyed by workspace sessions and the rule excludes exactly those. A removal event would add a new wire shape through IPC, remote frames and three readers to handle a state that cannot occur. Instead, the protection is tested at its source of truth: the recorded workspace fixture's own identities are made the oldest records and are not evicted.

**Residual wording corrected.** The earlier body said turn-end enforcement "re-creates" an evicted record. It does not: it prompts or blocks, and only the agent's own `goal_set`/`tldr_update` writes. Under the final policy a running agent is never evicted, so that path no longer matters.

**Tests added:**
- a workspace-named goal is never evicted and can still be completed;
- all-in-use and unknown both refuse and leave the file byte-identical;
- revision continuity for both stores, from the highest real revision;
- one atomic write under an injected rename fault (a two-write implementation is killed);
- history is kept for the evicted identity and written for the new one;
- the host lists unrevoked identities only.

## Review round 2 (#1328): the in-use set was incomplete and could go stale
- **Session-id fallback (a, b, c, Major).** The renderer reads a session that has TLDR or Goal enabled but no explicit `tldrIdentity` under its session id (`tldrIdentityForSession`). The in-use set had only explicit identities, so such a parked goal could be evicted. **Every persisted session id is now protected as well.** That is a superset of the renderer rule, so it cannot drift from it.
- **Stale in-use during the write (a, b).** In-use was sampled before the commit's disk I/O. `commit()` now asks again right before the rename. If an evictee has come into use, it refuses (`<label> storage is busy; try again.`) and writes nothing; the agent's retry then chooses afresh. What is left is the rename syscall itself.
- **TLDR protection unpinned (a).** The workspace test now runs for both stores.
- **Main wiring unpinned (c).** The stores are built by `createReportingStores(stateDir, inUse)`, where `inUse` is required, and a test drives both stores through it.
- **Declined: remember revisions before the commit (b's survivor).** b found no user-visible effect, and neither do I: after a refused write the record is still in memory, and its own revision wins.
- **Residual:** a pane added in the renderer is not in the persisted workspace until its autosave, up to 400 ms later. If it also has no live MCP registration in that window, its identity is unprotected. A new agent's pane has a live registration, so that needs an agent that spawned and exited within 400 ms, while the store is at the cap.
