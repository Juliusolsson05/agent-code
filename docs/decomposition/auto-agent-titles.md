# Auto agent titles decomposition

Status: Stages 0–3 built 2026-09-24; final checks and review in progress. Implementation pre-authorized by the user's “implement all of this” instruction.
Approval mode: pre-authorized. Stop if recorded provider behavior contradicts the ownership design, if a native hook would require modifying user configuration, or if manual-title semantics cannot be preserved.

## Why this applies

The visible title is consumed by live panes, Dispatch, remote views, and the conversation catalog. The authenticated provider process lives in main while durable workspace state lives in a renderer. Native provider titles are an additional, unequal signal. A direct provider write into one reader would make these sources disagree.

## A — existing trusted state

`SessionMeta.title` is the app title and workspace autosave persists it. `agent.title.set` and `agents.titleSet` use the same reducer; both accept terminals. The conversation ledger projects this title and the catalog prefers it over provider titles. Built-in MCP uses a process-scoped bearer; Goal/TLDR demonstrate self-scoped tools and Claude/Codex turn hooks. These facts do not establish manual provenance, a renderer-safe self-write route, or native hook support for every provider.

## D — observable end state

1. Auto Title is opt-in per provider/default and per agent, off by default.
2. An enabled agent can set a brief label for its current substantive job without naming a target session.
3. Routine progress leaves the title alone; a new job can replace an agent-authored title.
4. Manual titles and manual clearing protect the pane until Auto Title is explicitly resumed.
5. Agent writes reach the existing workspace title owner and every existing reader.
6. A revoked process, wrong session, or terminal cannot gain an agent title through this tool.
7. Provider turn hooks remind agents when a title is missing where a verified native route exists; unavailable hook coverage is visible and documented.

## Stage 0 — evidence

Method: extract from repo source, recorded corpus notes, and existing system tests. No new live workspace data was modified.

- H1: provider titles are uniform and sufficient. **DISPROVEN.** Claude's recorded 371-transcript sample has 310 `ai-title` records and six `customTitle` records; Codex's recorded catalog has 2,007 index rows whose names are usually truncated first prompts; OpenCode and Grok have generated fields; Pi names are `session_info`. Evidence: `docs/decomposition/conversations.md` and `src/main/conversations/sources/*`.
- H2: the live pane consumes provider titles. **DISPROVEN.** The pane/Dispatch reads `SessionMeta.title`; the catalog has a separate native-title fallback. Evidence: `workspace/agentTitle.ts`, `workspace/sessionDisplayTitle.ts`, `conversations/catalog/label.ts`.
- H3: existing Goal/TLDR transport can authorize a self-scoped tool. **HOLDS.** `BuiltInMcpHttpHost.registerSession` mints a bearer per launched process and revokes it on replacement; `createBuiltInMcpServer` scopes `goal_set`/`tldr_update` to that registration.
- H4: all five providers currently receive turn-hook nudges. **DISPROVEN.** The app injects hooks only for Claude/Codex. Grok upstream now documents a Stop continuation, while OpenCode and Pi expose different extension/event paths. Their exact app launch contracts need a recorded probe before parity can be claimed.

Stage 0 results: five provider MCP routes; two app-integrated turn-hook routes; one app title owner; one catalog ladder; no persisted title provenance. Native titles stay fallback inputs, not competing writers, in this feature.

## Stages

### Stage 1 — title ownership contract

- Produces: title provenance/pause metadata and pure manual/agent/resume reducers; an opt-in `auto_title` MCP domain and managed instructions.
- Verified by: migration of legacy titles, manual clear/pause, terminal refusal, no-op, and replacement/reload tests.
- Why separate: persistence and precedence must be decided before a provider can write.
- Reality check: existing workspace title tests and recorded SessionMeta replacement paths.

### Stage 2 — authenticated cross-process write

- Produces: self-scoped `title_set` tool and application-only control capability that reaches the exact renderer-owned session; revocation and owner checks.
- Verified by: MCP client/host and control bridge system tests, including stale calls and manual precedence.
- Why separate: main cannot become a second workspace title store; the model cannot choose a target session ID.
- Reality check: existing Goal/TLDR bearer tests and control owner routing tests.

### Stage 3 — native guidance and presentation

- Produces: managed Auto Title skill, bounded hook nudge in verified provider paths, user setting/agent control, resume action, and user-facing guidance.
- Verified by: provider launch config tests, renderer setting/command tests, representative pane/catalog behavior.
- Why separate: hook delivery is provider-specific while title ownership is not.
- Reality check: existing Claude/Codex hook fixtures; OpenCode/Grok/Pi behavior must be probed or explicitly reported as guidance-only.

## Isolation

| Signal | Owner | Mechanism |
|---|---|---|
| Agent-authored app title | renderer workspace reducer | authenticated MCP → main control host → application-only exact-session capability |
| Manual app title and pause | renderer workspace reducer | existing command/operator paths and explicit resume |
| Native provider title | conversation source adapter | catalog fallback only |
| Turn timing | provider-specific hook adapter | one shared missing-title policy where verified |

The MCP runtime may not import renderer state. Provider adapters may not write workspace metadata directly. Conversation sources may not write the app title.

## Unknowns and fixtures

1. Grok's documented Stop semantics against the runtime Agent Code launches — Stage 3 probe.
2. OpenCode/Pi safe process-local hook injection and title cadence — Stage 3 probe; guidance-only if not proven.
3. Cross-window delivery/replacement race — Stage 2 system test and exact owner check.

Use recorded Claude/Codex hook vectors, the existing provider conversation corpus, and actual workspace replacement/control fixtures. Label a contract-only fixture as such; do not invent native transcripts. If a fixture disproves an invariant, revise this decomposition before adding a conditional.

## Stage 3 provider verdict

- Claude and Codex: `src/providers/claude/runtime/claudeSession.ts` and `src/providers/codex/runtime/codexSession.ts` already inject process-local turn hooks from the built-in MCP launch config. The new domain uses those same hooks and their single continuation policy. Real host tests cover a title-only registration and combined Goal/TLDR behavior.
- Grok: the launched `grok-code-headless` control route in `src/providers/grok/runtime/grokSession.ts` seeds MCP servers but exposes no process-local hook configuration through Agent Code's current adapter. Grok 1.0.30 documents Stop hooks, but using a machine-wide configuration would cross the stop condition above. This provider receives the tool and skill without a turn reminder.
- OpenCode: the app observes `session.idle` on its SSE bus, but the current launch path does not inject a process-local, block-capable turn hook. An idle event cannot provide the same bounded Stop continuation. This provider receives the tool and skill without a turn reminder.
- Pi: the Agent Code bridge extension observes `turn_end`/`agent_settled` and exposes MCP tools, but it has no current title-specific continuation contract. This provider receives the tool and skill without a turn reminder.

The guidance-only limit does not create a second title writer. Any future provider hook must preserve the renderer ownership and one-block-per-turn invariants before enabling a reminder.

## Graveyard

- Native title as the sole app title: rejected by H1/H2; loses consistent current-job semantics and manual provenance.
- Hook-generated title on every response: rejected by the requested title cadence; would add model calls and churn on ordinary progress.
