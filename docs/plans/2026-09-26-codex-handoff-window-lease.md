# A Codex same-rollout handoff releases the predecessor's window lease (#1283 item 2)

## Problem
In a Codex same-rollout replacement, main kills the predecessor P inside `spawn` (`executeCodexReplacementHandoff`), and the renderer then skips `killOwnedSession(P)` (`mainHandledPredecessor`). That call was the only release of P's `SessionWindowRouter` lease, so P stays owned by its window for the rest of the app run.

What the leaked lease costs:
- a `renderer_replaced` gap is recorded and flushed for P on every renderer reload;
- a window close bequeaths the dead P to the surviving window;
- late events for P are delivered instead of quarantined;
- requests scoped to P still route to that window (Orchestration, AgentManagement, Workflow bridges);
- another window cannot claim P.

## Evidence
- The lease is claimed when the id is minted in `session:spawn` (`ipc/session.ts`). It is released on a failed spawn, `session:kill`, `session:kill-owned` (only when the manager no longer retains ownership), and an abandoned bequest.
- After the handoff, P is held first by a reservation and, after `acknowledgePersistedSessionOwnership`, by a redirect, so `retainsSessionOwnership(P)` stays true. A renderer `killOwned(P)` would tear down the successor through the redirect, so the renderer cannot be the one to release it.
- `sessionRoutingComposition.test.ts` pins that the claim is kept while a reservation owns P: `restoreCodexReplacementPredecessor` can bring P back after a failed start.
- No test covers the lease after a committed handoff.

## Decision (default)
- **Release at the commit.** `acknowledgePersistedSessionOwnership` runs after the workspace rename that makes the successor durable. It returns the predecessor ids it committed, and `workspace:save` releases each one's window lease.
  - Before the commit the lease stays, because compensation may restore P.
  - After the commit nothing displays P.
  - A stale renderer that later recovers P (the redirect reclaim path) claims a fresh lease through `session:recover`, as any recovery does.
- **No change to the renderer, the redirect or the reservation lifecycle.**

## Tests
- **Manager:** a committed handoff reports its predecessor exactly once; an unacknowledged successor reports none.
- **IPC:** `workspace:save` releases the window lease of each committed predecessor and of nothing else.
