# Reload Agents re-checks ownership around every await (#1282)

## Evidence
`reloadAgentSessions` (session.ts) walks a snapshot of the agents. For each one it kills the old backend, awaits `spawnSession`, and commits the whole id map at the end. Nothing re-checks the workspace between those awaits:
- **A close mid-reload** (an agent closed after the snapshot) is still respawned. It comes back under a new id, or as an invisible orphan if its project closed.
- **A replace of the same agent mid-reload** (for example a provider switch) yields two successors on one provider transcript. `replaceSession` guards this with `canCommit` (#815); reload does not.
- **The draft** comes from a runtime snapshot taken before the slow sequence, so text typed meanwhile is lost. `draftImages` and `unreadSince`/`unreadKind` are never copied, so toggling dangerous mode clears every "finished, not seen" marker.

## Change
- **Before each kill,** the agent must still be the same owned agent (`canCommit`'s rule: same cwd, kind and runtime, and still owned). Otherwise it is skipped, with no kill and no spawn.
- **After its kill and after its spawn,** the same check runs again. If the agent went away, nothing is spawned, or the new process is killed and nothing is filed. (Superseded in detail by the round sections below: each agent now commits on its own.)
- **The draft, draft images and the unread marker** are read from the live runtime at commit time.

## Tests
On the recorded workspace fixture: a close during the reload, a replace during it, a close before the loop reaches an agent, and a draft typed and an unread marker set during it. Red on main.

## Review round 1 (#1326)
- **Overlapping reloads (A1).** On -> off before the first reload settled ran two loops over one snapshot and could leave the dangerous successors running. Reloads now run one at a time; the later click restarts the earlier one's successors with the final setting.
- **Project merge mid-reload (A2).** The successor was filed under its captured, now deleted, project. The commit now files it from the LIVE row; only the spawn's own fields (identity, MCP domains, resumed provider session) come from the loop.
- **Close during an orphan kill, and a rejected orphan kill (A3/A4, B1).** The commit-time checks and the commit are now one synchronous run. Orphans are killed after it, each in its own try/catch.
- **Failed respawn of a closed agent (A5).** It no longer recreates a `failed` runtime under the closed id.
- **Mutation survivors (cwd check, project-ownership clause).** Pinned by a cwd change and a removed project mid-reload.

Tests: 7 new cases on the same fixture, 5 red against the round-1 head (the two mutation pins pass there, as they cover existing behavior).

## Review round 2 (#1326): each agent commits on its own
Round 1's synchronous batch commit left two intervals open, and round 2 (reviewers A and C, steering q47) found them:
- **C1: after the pre-spawn kill.** A close that finished while the old backend's kill was awaited was followed by a spawn anyway. The loop now re-checks ownership after that await.
- **C2: an early successor unfiled while a later spawn stalls.** Closing the pane killed only the old backend, and the successor kept running, possibly in dangerous mode. **Each agent is now committed as soon as its own spawn returns** (the same one-pair remap `replaceSession` uses), so the successor IS the pane, and a close from then on is an ordinary close. The only remaining interval is the spawn itself; a close there orphans the successor, which is killed at once, not after the whole loop.
- **C3: a swallowed orphan-kill rejection.** The contract is now: retry once at once; if that also fails, keep the successor in `unstoppedReloadSuccessorsRef`, which the next reload retries first; log a curated line (no IPC text, q22). Application quit (`killAll`) stops every backend regardless, so none is ever ownerless. It still does not throw, so the other agents are restarted and filed (round 1, A4).
- **A1: dropped durable provider id.** A fresh start (the old id was provisional, so nothing is resumed) now keeps the `providerSessionId` spawn reports, as `runtime-start`, the same rule as `spawn()`. The live row's provider fields are never copied.
- **The `providerRuntime` clause** of the ownership rule is now pinned too.

Not adopted: routing reload through `replaceSession`. That function spawns successor-first with the ambient dangerous-mode setting and a Codex same-rollout handoff; reload kills first and passes an explicit mode. Merging them changes behavior beyond this fix.

Tests (on the same fixture): C2 is asserted with the later spawn still held, closing through the real `killSession` action. C1 closes while the reload's kill is held. C3 counts the retry and the next reload's retry. A1 covers both directions: a reported durable id is kept, and a provisional id is not carried. 4 of these are red on the round-2 head; the `providerRuntime` and provisional-id cases pin existing guards, and a mutation removing either one fails them.

## Verification pass (#1326, reviewers A and C) and steering q56
- **A remembered orphan was never retried once no live agents remained (A, C; Major).** The retry loop ran after the no-live-agents return. It now runs first.
- **A refused kill cleared the retry record (C; Major).** `session:kill-owned` answers `false` for both "gone" and "not yours, still running". Only `true` now clears the record. A backend that was already gone costs one IPC call per later reload.
- **An all-failed reload no longer pruned unowned rows (A; Minor).** They are pruned once, up front. The per-commit prune is removed: with the up-front prune it was a second mechanism nothing pinned (A's surviving mutation).
- **Relationship and pin remap survivors (C).** The early-successor test now asserts, while the later spawn is still held, that a child's `linkedParentId`/`orchestrationParentId` and the pin already follow the successor. Removing either remap fails it.

Tests: 3 new cases (red on `f897700f`) plus the interval assertions above. Workspace suites: 1354/1354.

## Second verification (A, C)
- **Rows unowned mid-reload (A, Minor).** A project removed while an earlier spawn was in flight left its rows after the up-front prune. The per-successor commit prunes again. Both prunes are pinned: the all-failed test and the new mid-reload test.
- **An orphan's early runtime entry (A, C; Minor).** A confirmed orphan kill now also drops the renderer's bookkeeping for that id. `forgetSessionLocally`, extracted from `killSession`, is shared by both.

Tests: 2 new cases (red on `b6440143`).
