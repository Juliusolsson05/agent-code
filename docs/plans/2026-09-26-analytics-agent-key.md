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

## Round 1 review decisions (#1342)
- **b1: a successor's turn can close before its row is saved.** The projection reaches main only through the debounced autosave, so that interval is keyed by the bare session id, and the append-only log can't rewrite it. **c1: every live agent splits once at upgrade**, because its earlier rows are keyed by its session id. Same root cause: a session-id key is provisional. Fix: `aliases.jsonl` beside the log.
  - Whenever the projection ties a session id to an identity, the recorder appends `sessionId → identity`, plus `tldrIdentity → agentNameId` when both exist, so an agent that gets a name later joins too.
  - `readIntervals` resolves every key through the alias chain.
  - Rows are never rewritten. Tests cover the reviewer's probe, a pre-upgrade row of a live session, and a later name; all are red on the round-1 head.
- **c: nothing tested the session-id fallback** (an `'anonymous'` fallback survived). Test added: two agents with neither a name nor an identity stay two.
- **b2: an agent with both TLDR and Goal disabled has no `tldrIdentity`, so it still splits.** Declined here: the identity is minted by the renderer only for reporting domains (`hasReportingDomain`). Giving every agent an identity is a separate decision about what that id means. The defaults enable both domains.
- **c: `Fixes #1302` overstated.** Now `Refs #1302`. The residuals, recorded on the issue, are b2 and history: rows of predecessors that are no longer live can't be joined, because nothing links their session ids to an identity.
- **Steering q63: an alias edge was acknowledged before its append succeeded.** The recorder's sent-set and the store's in-memory map both did it, so a failed write was never retried and a restart lost the edge. Both now record the edge only after `appendFile` succeeds, and a failed append is logged, not thrown into `flush`. Test: `aliases.jsonl` is unwritable for the first projection, restored, the same workspace is projected again, then a restart sees one agent. It is red with either early acknowledgement.

## Verification round decisions (b and c at `7cec1796`)
- **Alias cycle.** Turning names on gives a pane its own session id as its name, so edges point both ways (`child → tldr`, then `tldr → child`), and directed resolution split one agent. Aliases are now read as groups (union-find): every key an edge connects is one agent, represented by the smallest key. `agentKey` is only a grouping and React key downstream, so the choice of representative has no other effect.
- **Torn last line.** A crash's torn last line swallowed the next append, in `aliases.jsonl` and in the month files alike. `appendLines` checks each file's tail once per process and starts on a fresh line.
- **Crash before the successor's row is saved.** No projection ever aliases it. The recorder now also takes the identity main registered at spawn (`BuiltInMcpHttpHost.sessionTldrIdentity`, read when the session starts), so the interval carries it from the start. The key is `agentNameId ?? tldrIdentity (projection) ?? identity at spawn ?? sessionId`.
- **A failed alias write** was already fixed (steering q63, `f87bc413`).
- Tests for each are red on `f87bc413`.
- **b (round 3): the summary's still-open intervals kept raw keys** while closed ones were grouped, so a working agent showed twice until its turn closed. `AgentActivityStore.agentKeyGrouping()` is now the one mapping, used by `readIntervals` and by `summary` for open intervals. Test added; it is red without the open-interval grouping.
- **b (round 4): the closed and open intervals were grouped from two alias snapshots,** so an alias saved mid-summary split one agent. `summary` now takes one `agentKeyGrouping()` snapshot and passes it to `readIntervals`. Test: an alias appended right after the closed intervals are read; red on `a65245ef`.
