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

## Steering q51/q52: final design, no deletion ever races registration
The q51 attempt, "evict, then give the record back if its identity registered during the rename", was withdrawn. q52 showed it still loses a live goal: when the evictee is the only unused record, there is no second record to displace, so it cannot be given back. It also left a crash window between two renames. Each round had found a new loss path, because the design deleted first and compensated after.

**Final design.**
- Each store counts **pins** per identity. `pin()` and `unpin()` run in the store's own `serialize` queue, the same queue every `update` and `complete` runs in.
- The spawn path awaits `BuiltInMcpHttpHost.pinReportingIdentity(scope)` **before** `registerSession`. It pins the exact identity the registration will report as (explicit, or the session-id fallback). `revokeSession` releases it. Counting matters because a replacement registers its successor before revoking its predecessor under the same identity.
- An eviction chooses its victim (the least recently written record that is neither pinned nor named by the persisted workspace) and commits it inside ONE queued operation. A pin queued before that operation protects the record. A pin queued behind an eviction in flight waits for that write to land, so the session never becomes live while a write deleting its record is landing.
- When no unused record exists, the new identity's write is **refused** with `<label> storage is full.`, and nothing is deleted.
- Removed: the restore pass, the pre-rename "busy" recheck, and `liveTldrIdentities` (the host's registration scan). There is one mechanism, not a compensation.

**What the invariant is.** A record is never deleted while its identity is live or named by the persisted workspace. Consider a session that registers AFTER an eviction chose its identity: at the moment of choosing, the identity was unused, so that eviction was correct. The session starts with "No goal yet", exactly like any identity evicted earlier.

**Residual (stated concretely).** A pane added in the renderer reaches the persisted workspace at its autosave, up to 400 ms later. Its live session is pinned from spawn, so the pane is protected; the window only matters for a pane whose session is not live, which a new pane is not.

**Tests.** Each is red on the q51 head `659adf13` (where `pin` does not exist) and each is mutation-checked:
- the sole-unused-record case from q52 is refused, the file is byte-identical, and the live goal can still be completed;
- a pin requested during an eviction's rename resolves only after that write has landed;
- pins are counted;
- the spawn path pins before it registers (`sessionManager.wake.test.ts`);
- the host pins exactly the registration's identity and releases it on revoke.

Mutations: ignoring pins in the choice fails 5 tests; a pin that bypasses the queue fails the race test.

## Verification pass (a, b, c) and steering q56
Two reproduced loss paths remained after the q52 redesign:
- **A workspace save naming the evictee during the eviction's write (a, b, c; Major).** Pins protect live sessions, but a parked pane is named only by the workspace file, and `WorkspaceFileStore.commit` had its own queue. **Fix:** a small shared lock, `withReportingPublicationLock` (`src/main/storage/reportingPublicationLock.ts`).
  - `WorkspaceFileStore.commit` holds it for write, rename, and the `this.file` advance that the stores' in-use answer reads.
  - An *evicting* store write holds it for sample, choose, write and rename.
  - Lock order is always "own queue, then the lock", and neither side waits on the other's queue, so there is no deadlock. Non-evicting store writes take no lock.
  - A save that names the evictee after the choice waits until the write has landed. It never overlaps it.
- **A pre-registration pin with no owner (a, b, c; Major).** A spawn cancelled after pinning, or a `registerSession` that threw, left a pin nothing could release. At a full store whose only free record it protected, every new agent was refused until restart. **Fix:** `pinReportingIdentity` returns an idempotent `release`, and `SessionManager.spawn` calls it when cancellation or registration throws. A partial pin failure (one store pinned, the other failed) releases the store that pinned before rethrowing (`allSettled`). Once registered, `revokeSession` releases, as before.

Tests (all mutation-checked; each mutant fails exactly one test):
- a workspace save requested during the eviction's rename sees the completed write, and its naming then protects that identity;
- `WorkspaceFileStore` does not rename or advance while the lock is held;
- through the real host and a real capped store, an unregistered pin's release frees the sole candidate, and a partial pin failure releases the other store;
- `SessionManager.spawn` registers only after the pin settles and releases it when cancelled.

Mutants: the store without the lock; the workspace without the lock; no release on cancel; an unawaited pin.

**Invariant, as it now stands:** a record is never deleted while its identity is pinned by a live or registering session, or named by the committed workspace. A pane or session that names an identity only AFTER an eviction chose it starts without that record ("No goal yet").

## Second verification (a, b, c)
- **A registration that creates no token (a, b, c; Major).** The q56 release covered a cancelled spawn and a throwing `registerSession`, but not a *successful* call that registers nothing. A recovered Claude session with an explicit identity and only the `workflows` domain (which the provider policy filters away) got `[]` and no token. Its pin was then never released: the spawn treated it as registered, and `revokeSession` had no token to release through. **Fix, by ownership:** `registerSession(scope, releasePin)` takes the release. It calls it at once when no registration is created, and otherwise stores it on the registration, which `revokeSession` calls exactly once. `revokeSession` no longer unpins by identity, so every pin has exactly one owner.
- The q56 lock and the other release paths were verified by all three reviewers: mutations removing either lock, or the cancel, throw or partial releases, went red, and no cyclic wait was found.

Test: through the real host and a capped Goal store, a policy-filtered registration returns `[]` and the sole candidate is free again (red on `62d52c98`).
