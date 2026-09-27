# A Codex same-rollout handoff releases the predecessor's window lease (#1283 item 2)

## Problem
In a Codex same-rollout replacement, main kills the predecessor P inside `spawn` (`executeCodexReplacementHandoff`), and the renderer then skips `killOwnedSession(P)` (`mainHandledPredecessor`). That call was the only release of P's `SessionWindowRouter` lease, so P stays owned by its window for the rest of the app run.

What the leaked lease costs (wording corrected after review c):
- P keeps an entry in the router's owner map for the whole app run;
- every renderer reload revisits it and records a `renderer_replaced` gap for it (normally invisible, since no pane shows P);
- a window close bequeaths the dead P to the surviving window;
- another window cannot claim P;
- until the owning window's first reload, late events for P and P-scoped requests (Orchestration, AgentManagement, Workflow bridges) still route to that window. After a reload they are quarantined against the stale generation.

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

## Round 1 review decisions
- **b: three untested safety conditions.** Each survived a one-line mutation:
  - acknowledging before the durable write: a test with a failing write checks that nothing is committed or released;
  - dropping the successor-presence guard: another window's save naming neither id retires nothing;
  - releasing only the first of two retirements: the IPC test now retires two predecessors.
- **b: no end-to-end check through the real registry.** A `sessionRoutingComposition.test.ts` case now claims through the real registry, saves through the real `workspace:save`, and expects `windowForSession(P)` to be null while a bystander keeps its claim.
- **c: the cost of the leak was overstated.** The plan and the code comment are corrected.
- **c: the release must not depend on which window saved.** The composition case saves from the other window. A same-window-only mutation now fails.
- **a: adoption changes the durable set without an acknowledgement.** A closed window's slice is removed only after its survivor confirms adoption (`window:adoption-complete`). While the slice still listed the predecessor, the survivor's save rightly committed nothing, and nothing asked again once the slice was gone. Now `commitDurableOwnership` (acknowledge, then release) runs after both durable changes: a save, and an adoption's slice removal. Tested through the real registry: `windowForSession(P)` is null once the adoption completes.
- **a: the predecessor-still-persisted guard had no test.** Now pinned: a set holding both P and S commits nothing.
