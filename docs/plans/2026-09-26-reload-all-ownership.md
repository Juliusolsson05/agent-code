# Reload Agents re-checks ownership around every await (#1282)

## Evidence
`reloadAgentSessions` (session.ts) walks a snapshot of the agents. For each one it kills the old backend, awaits `spawnSession`, and commits the whole id map at the end. Nothing re-checks the workspace between those awaits:
- **A close mid-reload** (an agent closed after the snapshot) is still respawned. It comes back under a new id, or as an invisible orphan if its project closed.
- **A replace of the same agent mid-reload** (for example a provider switch) yields two successors on one provider transcript. `replaceSession` guards this with `canCommit` (#815); reload does not.
- **The draft** comes from a runtime snapshot taken before the slow sequence, so text typed meanwhile is lost. `draftImages` and `unreadSince`/`unreadKind` are never copied, so toggling dangerous mode clears every "finished, not seen" marker.

## Change
- **Before each kill,** the agent must still be the same owned agent (`canCommit`'s rule: same cwd, kind and runtime, and still owned). Otherwise it is skipped, with no kill and no spawn.
- **After its spawn,** the same check runs again. If the agent went away meanwhile, the new process is killed and nothing is filed.
- **At commit,** only entries whose old agent is still present are applied; any other successor is killed.
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
