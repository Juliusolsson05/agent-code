# Agent Analytics counts one agent once across replacements (#1302)

## Problem
`AgentActivityRecorder.contextFor` keys an agent as `agentNameId ?? sessionId`. Agent names are off by default, so almost no agent has an `agentNameId`. A reload, provider switch, resume, rewind or MCP toggle gives the pane a new session id, and the same agent then starts a new analytics row: the "agents" totals over-count, and one agent's time is split across rows. The design doc admits the over-count (`docs/decomposition/agent-working-time.md`, the "Agent" bullet).

## Evidence
- The owner's `workspace.json` has 98 agent sessions: all 98 have a `tldrIdentity`, but only 3 have an `agentNameId`. So about 95% of agents are keyed by session id today.
- The owner's analytics log (`agent-activity/2026-09.jsonl`) has 578 distinct agent keys for 467 distinct (label, tab, cwd) contexts. One untitled "agent-code" context alone has 94 keys. That grouping is a coarse proxy (untitled agents share a label), so treat it as a sign of the over-count, not a measure.
- `tldrIdentity` is carried by the renderer only when the successor continues the SAME conversation (`tldrIdentityForReplacement`: same provider and same native transcript, or a provider translation). Rewind, clone and unrelated resumes get a fresh one. That is exactly "the same agent". The workspace projection main already reads carries it (`workspaceProjection.ts`).

## Decisions (defaults)
- **Key = `agentNameId ?? tldrIdentity ?? sessionId`.** The name stays first so rows already keyed by a name keep their key. `tldrIdentity` covers everyone else, and the session id remains the last resort.
- **No migration of old rows.** Past intervals keep the keys they were written with, because the log holds no link from an old session id to a `tldrIdentity`. Counts improve from now on.
- **The design doc's Agent bullet is updated** to the new key.

## Tests
`AgentActivityRecorder.test.ts`: an agent replaced by a successor with the same `tldrIdentity` is one agent in the summary, with both sessions' time summed. Red on main.
