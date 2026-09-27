# Undo Close keeps a derived TLDR identity (#1347)

## Problem
Undo Close respawns a closed agent with `tldrIdentity: meta.tldrIdentity`. An agent whose identity is DERIVED has no explicit field. That happens when reporting domains are on but main created the agent, or its metadata arrived after it acquired TLDR or Goal. The rule is `tldrIdentityForSession`: the identity is the session id. Undo Close passes `undefined` for such an agent, so `spawn` mints a fresh UUID: the restored agent gets a new TLDR/Goal identity, and Agent Analytics (#1342 keys by it) splits its time. Reload Agents already passes `tldrIdentityForSession(oldId, meta)`.

## Decision
The Undo Close respawn uses `tldrIdentityForSession(closedSessionId, meta)`, the same rule as reload. `respawn` now takes the closed id; every caller has it (a single pane's entry, a project member).

## Test
`undoCloseFailure.renderer.test.tsx`: a closed agent with a reporting domain and no explicit identity is respawned with its closed session id as `tldrIdentity`; an explicit identity is still passed through unchanged. Red on main.
