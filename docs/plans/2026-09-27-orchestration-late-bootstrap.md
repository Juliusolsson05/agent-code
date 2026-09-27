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

## Review round 1 (a, codex at `2e4bd384`): FIX-BEFORE-MERGE

| Finding | Verdict | Change |
|---|---|---|
| **a1, major:** a late delivery refused as not-ready, on a provider with no readiness gate (OpenCode, Grok), left the child idle, though the parent had been told delivery was automatic | valid | The late path retries on a bounded backoff (2, 4, 8, 16, 30 s, about a minute). It stops as soon as any prompt has landed on the child, so there is never a second copy, and it records `create_agent_late_bootstrap_never_ready` if the child never gets ready. The punctual path is unchanged: its parent sees the failure and retries. The timeout reply no longer promises delivery outright; it says Agent Code retries while the child starts, and to check `orchestration_read_agent` for `promptSubmitted` before sending the brief. Tests: ready on the third try, never ready (6 attempts, then the incident, then nothing more), and a prompt landing some other way (stops). The "no landed check" mutant is red. |
| **a2, major:** the late continuation could start the brief after the parent was closed mid-spawn | valid | `adoptLateResponse` checks the parent with the same `windowForSession` lease dispatch uses, and skips the delivery with an incident (`create_agent_late_bootstrap_parent_gone`). The child itself is left for the user: closing an agent is not this path's call. Test red at the previous head; the "no parent check" mutant is red. |
| **a survivor:** `supersedesPendingPrompt: false` | noted | a judges `false` correct (a newer parent prompt keeps precedence). The late path never arms for providers without a readiness gate, and the retry loop's landed-prompt check covers the late-versus-parent race it would otherwise decide. |

## Review round 1, b (codex at `cacd7ec0`): FIX-BEFORE-MERGE

| Finding | Verdict | Change |
|---|---|---|
| **b1, major:** the parent was checked once, at adoption; a parent that closed during a retry delay still had its brief delivered | valid | `OrchestrationBridge.isParentAttached` (the dispatch lease), checked before EVERY late attempt, with a `create_agent_late_bootstrap_parent_gone` incident. System test red with the check removed. |
| **b2, minor:** the FAILED late-answer fixtures lacked `type`, so the `!response.ok` guard was never reached, and its removal survived | valid | Both fixtures carry `type: 'create-agent'`; removing the guard is red (2 tests). |
| **b survivor:** removing every `lateCreates.delete` passed (the long-lived bridge would keep each create's continuation) | valid | Pinned: the map empties after an in-time create and after a late one. Removing the deletes is red. |

## Review round 1, c (codex at `cacd7ec0`): FIX-BEFORE-MERGE

| Finding | Verdict | Change |
|---|---|---|
| **c1, major:** a parent closing during a retry delay still got its brief delivered | valid, **already fixed** in `5f54f8c0` (b1) | The parent is re-checked before every late attempt; c reviewed the prior head. |
| **c2, minor:** the timeout reply promised more than the contract (a renderer that never answers means no delivery at all) | valid | The reply now says delivery is *attempted* if the renderer later confirms the child, names the ways it can fail, and tells the parent to check `orchestration_list_agents` and `orchestration_read_agent` (`promptSubmitted`) before sending. |
| **c survivor:** shrinking the last backoff delay to 1 ms passed (only the total count was checked) | valid | Each wait is pinned exactly (no attempt 1 ms early, one exactly on time), with microtasks drained without moving the clock. The last-delay and first-delay mutants are both red. |

## Review round 2 (a, b, c codex at `ed86637b`): all FIX-BEFORE-MERGE, the final round

| Finding | Verdict | Change |
|---|---|---|
| **a + b, major:** on a provider WITH a readiness gate (Claude, Codex), the late attempt arms a waiter that could deliver after the parent detached; the per-attempt check does not govern it | valid | `SessionManager.deliverPromptWhenReady` takes a `shouldDeliver` guard, asked the moment the gate opens, before anything is written; a refusal is `do-not-retry` with nothing written. The late path arms its waiter with the parent-lease check. Manager unit tests (refuse writes nothing / allow delivers as before) and a system test that the late waiter carries the guard. Red at `ed86637b`. |
| **c, major:** the renderer files the child before its create answer reaches main, so the parent can send first; adoption reset the child's record to zero and the late bootstrap sent a second brief | valid | Adoption keeps an existing delivery record. A system test sends through the real `orchestration_send_prompt` before the late answer: one delivery in all. Red at `ed86637b`. |
| **c, minor:** a reservation collision (the parent's send in flight) ended the late loop | valid | A `reservation` / `delivery-in-flight` result on the late path retries, re-checking the landed count and the parent first. Red at `ed86637b`. |
| **b, minor:** the stop test called `notePromptSubmitted` directly, so removing it from `send_prompt` survived | valid | The test sends through the real `orchestration_send_prompt` during a retry delay; the bookkeeping mutant is red. |
