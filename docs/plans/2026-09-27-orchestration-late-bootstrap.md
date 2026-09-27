# Deliver the bootstrap prompt to a late-created orchestration child (#1370)

## Problem
`orchestration_create_agent` waits at most 30 s for the renderer's `create-agent` answer (`OrchestrationBridge.dispatchRendererRequest`). The renderer answers only after the child's provider has started, and a healthy but slow start can take longer: the bundled OpenCode took 16.7, 18.3 and 43.1 s under CPU contention (#1367 review a).

When the deadline passes:
- the caller gets `OrchestrationOutcomeUnknownError` ("do not repeat");
- the MCP handler returns without delivering the prompt;
- the late answer is adopted (`adoptLateResponse`) with `bootstrapPromptDelivered: false`.

The parent is left with an idle child that never received its brief. It was told not to repeat the create, and nothing tells it the brief is missing.

## Decision (the issue's option a)
**When a timed-out create is adopted late, deliver its bootstrap prompt then**, through exactly the path a punctual create uses.
- The tool handler hands the bridge a late-create continuation along with the request. The bridge keeps it on the abandoned pending entry and runs it from `adoptLateResponse`.
- The handler's bootstrap delivery is extracted into one function that both paths call: deliver → `armPromptWhenReady` when the composer is not ready → mark the bootstrap delivered. The punctual and late paths therefore cannot drift.
- The late path has no caller to answer, so its outcome (delivered / pending / failed) goes to the incident journal. The adoption incident now records whether a bootstrap was attempted.
- **The timeout reply says so:** when a prompt was given, the outcome-unknown message adds that a child created late will receive its prompt automatically and must not be sent it again. Otherwise the parent's natural move, re-sending the brief after `list_agents` shows the child, would deliver it twice.

**Rejected: option b** (deriving the create deadline from the provider's start budget). MCP clients have their own tool-call timeouts, and a Codex parent's defaults are shorter than 120 s. A longer deadline would turn "unknown" into the client's own opaque timeout.

## Tests
- `src/main/orchestration/timeoutOutcome.test.ts`: a create with a late-create continuation times out, then the renderer answers. The continuation runs once, with the adopted (enriched) agent. A FAILED late answer runs nothing. A create that answered in time never runs it.
- The handler level: the create tool with a prompt, a renderer that answers after the deadline, and `deliverPromptToAgent` observed receiving the bootstrap for the late child. The timeout reply carries the "do not send it again" wording.
- Fail-first: both are red on `origin/main`.
