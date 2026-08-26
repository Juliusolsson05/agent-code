# Codex Reload Ownership Handoff

> **Status:** Stages 1–3 were implemented against the revised two-phase design.
> The fifth and sixth exact-head review findings are implemented through the
> isolated replacement ledger, including the follow-on close-during-restored-
> start and reverse-recovery ownership invariants found during local audit. The
> 75-test SessionManager cluster, typecheck, system 61/61, renderer 289/289,
> contracts, keybindings, live-resume probe, and packaged-build verification are
> green. Full unit is 1,556/1,557 with only the known missing external corpus
> session. The seventh exact-head review's five additional reachable ordering
> failures are implemented through contracts 29–33. The eighth exact-head
> review's two later transitions are now implemented through contracts 34–35.
> Their four red-first schedules are green; the affected main cluster is 94/94,
> typecheck, system 61/61, renderer 289/289, contracts, keybindings, live-resume
> probe, and packaged-build verification are green. Full unit is 1,569/1,570
> with only the same missing external corpus session. The ninth exact-head
> review converged on one remaining durability-liveness gap: an immediate
> successor-addressed replacement rejected during the preceding handoff's
> debounced-save window. Contract 36 is now implemented. Its two manager
> schedules and autosave retry fixture failed first and are green; the affected
> seven-file matrix is 82/82, typecheck, system 61/61, renderer 290/290,
> contracts, keybindings, live-resume probe, and packaged-build verification
> are green. Full unit is 1,571/1,572 with only the same missing external corpus
> session. The tenth exact-head review found two persistence-lifecycle edges in
> the new retry path: vetoed unload disabled its only retry, while persistent
> rename failure retried at fixed cadence and retained unique temp files.
> Contract 37 is now implemented. Its vetoed-unload retry, exponential-backoff
> and unmount-cancellation, and exact-temp-cleanup fixtures failed first and are
> green. The affected seven-file matrix is 85/85, typecheck, system 61/61,
> renderer 292/292, contracts, keybindings, live-resume probe, and packaged-
> build verification are green. Full unit is 1,572/1,573 with only the same
> missing external corpus session. Exact-head re-review, new-head CI, and live
> verification remain.
>
> **Incident:** Agent Code issue #638. Related fresh-rollout incident: #632.

## 1. A and D

### A — what exists and is trusted

| Artifact | Location | What is trusted |
|---|---|---|
| Exact rollout lease | `packages/codex-headless/src/transcript/FreshRolloutOwnershipCoordinator.ts` | One physical rollout path may have at most one active tail owner. Rejecting a second unrelated owner is correct and must remain fail-closed. |
| Pre-spawn resume preparation | `src/providers/codex/runtime/codexSession.ts` and `packages/codex-headless/src/CodexHeadless.ts` | A resumed Codex process reserves its exact rollout before PTY spawn, so ownership cannot be established after an untracked provider has already started. |
| Pane replacement sequence | `src/renderer/src/workspace/hook/actions/session.ts` | `replaceSession` currently starts the successor, then stops the predecessor. The sequence is source-confirmed and is incompatible with a same-rollout exact lease. |
| Main backend ownership | `src/main/sessionManager.ts` | Main owns the mapping from local session IDs to live/spawning provider backends and is the only layer that can await predecessor shutdown before admitting a successor. |
| Recorded failure | incident run `2026-08-26T17-57-28-324Z-main-70190-fd75b0` | Five ordinary Codex spawn attempts reached `replaying-history` and failed in 165–203 ms with the exact lease error while the original resumed pane remained live. |
| Unrelated proxy cleanup | `packages/codex-headless/src/proxy/CodexResponsesAdapter.ts` | Proxy watchdog release removes silent HTTP flow state. It does not own or retire rollout leases and is not the cause of #638. |

### D — observable end state

1. Reload Agent and built-in MCP toggles can replace a resumed Codex pane
   without hitting the exact-rollout lease error.
2. Main receives the local predecessor ID as an explicit handoff capability,
   validates that it names a live Codex backend, prepares every
   predecessor-independent successor resource first, and completes predecessor
   stop only at the exact resume-ownership acquisition boundary.
3. Ordinary new-pane resumes do not gain handoff authority and still fail
   closed if another live session owns the exact rollout.
4. Claude, OpenCode, terminal, fresh Codex, and replacement-to-a-different-
   transcript retain the existing start-success-before-old-stop behavior.
5. Recovery cannot reclaim the predecessor's local ID while replacement or
   compensation is in flight.
6. If successor startup fails after the destructive handoff, main restores a
   resumable Codex backend under the predecessor's original local ID before the
   renderer receives the failure, unless a close, successor kill, or global
   shutdown has cancelled the replacement transaction.
7. Lifecycle evidence records handoff and compensation outcomes, so a future
   failure is diagnosable without a stack trace or private transcript data.
8. Compensation is itself a cancellable stable-ID recovery and cannot publish
   a backend after the renderer closes the pane during restoration preflight.
9. Compensation waits for any predecessor recovery generation interrupted by
   handoff to retire its spawn fence before reusing the stable local ID.
10. A predecessor that exits naturally during successor preflight is joined as
    successful teardown; an explicitly closed predecessor cancels replacement
    and is never silently reclassified as safe.
11. A recovery timeout can cancel only the exact recovery generation whose
    deadline fired; it cannot match a later compensation claim merely because
    both use the same local ID, kind, and cwd.
12. A successful successor is not considered renderer-owned until a workspace
    save has durably replaced the predecessor local ID with the successor ID.
    If renderer reload/crash leaves the predecessor ID durable, recovery joins
    the pending transaction, retires the hidden successor, and restores the
    stable predecessor ID instead of colliding with an orphan rollout owner.
13. Workspace ownership acknowledgements occur in the same order as save IPC
    admission, so an older delayed write cannot overwrite or acknowledge after
    a newer renderer snapshot has already become durable.
14. Pending-handoff and committed-redirect reclaim publish a token-addressable
    cancellation record before their first await. A renderer deadline can
    cancel that exact reclaim generation even while successor spawn/stop is
    pending, and cancellation may retire a successor but never restore the
    predecessor after the deadline.
15. Global teardown cancels and joins every redirect reclaim, including the
    window after successor registry removal but before its asynchronous stop
    settles, so no backend can be resurrected after `killAll()` begins.
16. Explicitly closing a naturally exited committed successor retires its
    reverse redirect. Natural exit alone remains recoverable, but later stale
    predecessor state cannot resurrect a pane the current renderer closed.
17. Cancelling a pending-handoff reclaim actively cancels the reservation and
    starts generation-authorized successor teardown; cleanup does not depend on
    the blocked provider start deciding to settle by itself.
18. A reclaim owns any compensation generation it causes. Its exact timeout
    token cancels that associated compensation, while tokens from unrelated
    earlier recovery generations still cannot target it.
19. Replacement lineage lookup is bidirectional. A cancelled lineage fences
    both predecessor and successor IDs; an active current successor remains
    adoptable only while no close/reclaim owns its teardown.
20. Explicit close of either ID during pending-handoff reclaim cancels the same
    lineage even after registry removal, and the reclaim cannot restore the
    predecessor behind that close.
21. Explicit cancellation after verified handoff but before durable commit
    preserves a process-lifetime closed-lineage tombstone, so stale durable
    predecessor bytes cannot reverse close intent.
22. Timeout cancellation is retryable rather than a tombstone: after its exact
    reclaim generation settles and successor ownership is retired, a new token
    may start one fresh reclaim generation.
23. Flattening an acknowledged replacement chain may leave several stale
    predecessor IDs pointing at one current successor. Reverse lookup retains
    every alias, so recovery through the successor cannot miss an active
    reclaim merely because a newer redirect was indexed last.
24. Closing either ID of an unacknowledged S→T replacement also closes every
    committed ancestor ending at S. The closed-lineage transition retargets and
    tombstones those aliases with T before deleting the reservation, so stale P
    state cannot route around the newer close through an older P→S redirect.
25. Redirects retain ownership for both roles. `killOwned(P)` validates P's
    captured ownership while `killOwned(S)` and reverse cold `recover(S)`
    validate the successor ownership that was current when the redirect was
    committed or retargeted; differing same-resume cwd values cannot turn an
    explicit close into a stale miss or let old P metadata recreate S.
26. Reclaim admission is single-flight by physical successor, not only by stale
    predecessor ID. For flattened P→T and S→T aliases, the first reclaim owns
    T teardown and a competing alias receives a retryable conflict without
    cancelling the winner or sibling lineage. Successful recovery retargets
    surviving aliases to the newly restored physical owner.
27. Formerly-fresh path proof evaluates the resolved path before reacting to
    concurrent cancellation. A matching path publishes restore/tombstone
    material and retires the cancelled reservation through the closed-lineage
    transition; a non-match remains an unrelated spawn and creates no false
    lineage.
28. A committed redirect remains published while its winning reclaim starts
    the predecessor recovery. Only that exact reclaim generation may bypass its
    own redirect. Explicit close during restored-provider startup therefore
    converts the still-addressable redirect to a tombstone; timeout or a
    retryable start failure retains it for a later token instead of deleting the
    only anti-resurrection evidence before the risky await.
29. Explicit close follows an active replacement reclaim to the backend it is
    currently restoring, regardless of whether close arrived through the
    successor or any flattened alias. It cancels and stops that predecessor-
    keyed recovery generation before returning; a successful close may never
    leave an unreachable restored backend holding the rollout lease.
30. Cancellation during formerly-fresh transcript proof is terminal for the
    replacement request whether the eventual proof matches or not. A match
    first publishes the verified closed-lineage material; a non-match releases
    the unproven reservation, but neither result may fall through and start a
    successor after the predecessor pane was closed.
31. A workspace load admitted after a save waits for that save's complete
    write, rename, and ownership acknowledgement. Renderer reload cannot read
    older predecessor bytes while an already-admitted unload save is about to
    make successor ownership durable.
32. Every renderer token that joins an existing physical recovery or reclaim
    generation becomes cancellation authority for that generation only. A
    post-reload token can retire work whose original renderer and deadline no
    longer exist, while a delayed token cannot cross into a later generation.
33. Flattening changes only an alias's current physical successor identity.
    Each stale predecessor redirect retains its own captured restoration
    options, including cwd, so reclaim restores that durable ID in the project
    context its ownership proof validated.
34. A pending-handoff reservation remains the authoritative two-role lineage
    while its reclaim restores the predecessor. The nested recovery claim is
    associated with both reservation and reclaim before provider work starts;
    close through P or S and cancellation through any joined token stop that
    generation, while explicit close retains a closed-lineage tombstone after
    restoration settles.
35. Compensation belongs to the replacement reservation whether or not a
    renderer reclaim exists. Once compensation publishes its predecessor-keyed
    recovery claim, close/shutdown through either reservation identity can
    cancel and stop it; reclaim association is additional timeout authority,
    not the only route to the physical generation.
36. A replacement addressed to the live successor of an already-successful
    pending handoff waits for that exact handoff's durability transition rather
    than failing as a concurrent replacement. A committed transition admits
    the next replacement against the still-live successor; a reclaimed,
    closed, failed, or otherwise retired transition cancels the queued request
    instead of falling through to an ordinary spawn. Workspace autosave retries
    a failed write from the latest renderer state so the durability wait cannot
    become permanent merely because its first save attempt rejected. A second
    request against the original predecessor while teardown/start is still in
    flight remains a collision and is still rejected.
37. Workspace durability retry belongs to the mounted renderer generation, not
    to one debounce callback. A vetoed `beforeunload` cancels the prior timer
    and starts a retry-capable flush because the renderer may survive; an actual
    unload/unmount cancels whatever debounce or retry timer that generation
    currently owns. Consecutive failures use capped exponential backoff, while
    a successful save or newer state resets the delay. Main's atomic writer
    best-effort unlinks the exact invocation's unique temp file when write or
    rename fails, so indefinite eventual-success retry cannot accumulate one
    abandoned file per attempt.

## 2. Intermediate stages

### Stage 1 — turn the recorded sequence into a replacement contract

- [x] **Produces:** a sanitized lifecycle fixture describing the #638 ordering
  (`starting` → `provider.start.begin` → `replaying-history` → exact lease
  rejection) and a main-process regression test that models an existing resumed
  Codex backend followed by a replacement request for the same provider ID.
- **Verified by:** the test fails against `origin/main` because successor start
  occurs while the predecessor is still live; the assertion checks event order,
  not the coordinator's error string alone.
- **Why separate:** a test that merely expects the current error would preserve
  the bug. The real contract is ownership order across renderer, main, and the
  provider start boundary.
- **Reality check:** the five captured attempts all fail after provider start
  begins, while restart restores the original pane. That is the exact ordering
  the fixture must preserve.

### Stage 2 — add an explicit app-level handoff boundary

- [x] **Produces:** a typed replacement/predecessor field at the preload IPC
  boundary and a two-phase `SessionManager` handoff admitted only for a
  same-provider Codex resume targeting the predecessor's exact transcript. The
  first phase fences the predecessor ID and prepares the successor. The second
  stops the predecessor immediately before Codex acquires resume ownership. A
  failed second phase compensates by restoring the predecessor ID from captured
  main-owned launch facts.
- **Verified by:** Stage 1 becomes green; focused tests also prove an unrelated
  session ID and different resume ID cannot gain teardown authority, a failing
  MCP registration leaves the predecessor untouched, recovery is refused while
  the handoff fence exists, and a post-handoff start failure restores a live
  backend under the predecessor's original local ID.
- **Why separate:** the rollout coordinator cannot know Agent Code pane intent.
  Weakening its lease would make a UI convenience indistinguishable from the
  cross-wire it exists to prevent; the app-level manager has both identities.
- **Reality check:** `replaceSession` already knows the old local session ID,
  while `SessionManager` owns its kind, spawn-time launch facts, effective MCP
  domains, size, resume identity, and observed transcript path. Exact-head
  review demonstrated the two missing real sequences: `recover(oldId)` can run
  after teardown, and MCP/proxy/provider setup can throw after an eager kill.
  No heuristic UI timing is required to close either sequence.

The second exact-head review reopens this stage with one additional artifact: a
main-owned replacement transaction record containing predecessor and successor
IDs, cancellation state, the captured predecessor generation/entry, and a
cancellable compensation recovery claim. Explicit predecessor close, successor
kill, and `killAll()` cancel that record. Internal handoff teardown is the only
kill authorized not to cancel it. Compensation joins an interrupted recovery's
settlement before reusing the stable ID, publishes its own `RecoveryClaim`
before any awaited preflight, and rechecks cancellation before restoration.
Natural exit is accepted only from the captured predecessor generation after
its generation-owned cleanup settles; absence of an entry alone is never proof.

The third exact-head review reopens this stage with two further artifacts:

1. Recovery admission carries an opaque generation token supplied by the
   renderer request. The 30-second cancellation message must present that exact
   token, so a delayed cancellation for predecessor generation R cannot cancel
   compensation generation C after the stable local ID has been reused.
2. Successful replacement remains a main-owned pending transaction after spawn
   returns. The renderer must not issue its legacy predecessor kill for this
   path. A workspace save is the durable ownership acknowledgement: only a save
   whose owned session set contains the successor and not the predecessor may
   commit the pending handoff. Until then, rehydrate recovery for the durable
   predecessor ID joins transaction settlement and, on successor success,
   stops the hidden successor before restoring/recovering the predecessor ID.
   Main retains a bounded predecessor redirect after durable commit so a
   renderer that loaded the old workspace immediately before the atomic save
   can still reclaim safely; the redirect never weakens the exact-rollout
   coordinator.

The fourth exact-head review reopens this stage with two final ownership
artifacts rather than more renderer conditionals:

1. Workspace persistence has one main-owned ordering queue. Save invocation A
   must finish its write, rename, and ownership acknowledgement before admitted
   save B begins, so disk order and transaction-commit order cannot diverge.
   Unique temp paths remain necessary for crash-safe atomic replacement, but
   they are no longer treated as concurrency control.
2. Reclaim is represented by a generation-scoped record published before it
   awaits replacement settlement or successor teardown. The record carries the
   renderer recovery token, cancellation state, predecessor/successor IDs, and
   the reclaim promise. Exact-token cancellation, explicit close, and global
   teardown can therefore cancel/join the same generation even when neither ID
   currently has a registry entry or ordinary `RecoveryClaim`. Redirect lookup
   supports both predecessor and successor identity so close intent can retire
   a naturally exited successor's reverse redirect without weakening ownership
   validation.

The fifth exact-head review invalidates the assumption that three independent
maps plus call-site scans are an adequate ownership substrate. Stage 2 now
produces `src/main/sessions/codexReplacementLedger.ts`: the only index for
reservation, committed/closed redirect, and active reclaim records. It indexes
both predecessor and successor identities, classifies cancellation as retryable
timeout versus explicit close/shutdown, associates a reclaim with the exact
compensation claim it caused, and owns identity-safe register/retarget/delete
operations. `SessionManager` remains the sole executor of provider stop/start;
it consumes the ledger instead of directly arbitrating partial maps.

The reverse redirect index is one-to-many rather than one-to-one. This shape is
required by the existing commit-time chain flattening: after P→S and S→T are
acknowledged, both P and S legitimately point at T. The recorded incident did
not contain a repeated reload, but the production flattening loop makes this
state directly reachable; a deterministic manager test verifies that an active
P reclaim fences reverse recovery of T even though S→T was indexed later.

The same chain can be caught between acknowledgements: P→S is durable while a
successful S→T transaction is still main-owned. Explicitly closing S or T is
authoritative for the whole physical lineage, not only the newest reservation.
Before retiring that reservation, the ledger transition retargets every
committed ancestor ending at S to T and marks it cancelled. Keeping P→S active
would let stale P bytes bypass the S→T tombstone and recreate a pane the current
renderer already closed.

The sixth review adds two fields/indices to the same isolation rather than
moving policy back into callers. Every redirect carries `successorOwnership`
alongside `predecessorOwnership`, and retargeting updates it with the successor
ID. Active reclaims gain a reverse index by physical successor. Admission of a
second predecessor alias for that successor is rejected before either async
body can run, while internal teardown authorizes all sibling redirects. When
the winner restores a predecessor ID, surviving siblings are retargeted to that
new owner so they remain safe, recoverable aliases instead of false close
tombstones.

Formerly-fresh proof remains in `SessionManager` because the ledger must not
resolve provider paths. The resolved path is compared first; only a proven
match receives restore material and may become a closed-lineage tombstone.
`release()` then delegates cancelled verified reservations to the same ledger
retirement transition as every later close. This preserves close evidence
without letting an unproven different-transcript spawn inherit handoff power.

The winner does not delete its redirect merely to enter ordinary recovery.
Recovery admission recognizes the exact predecessor/reclaim/redirect triple
and lets only that internal call pass. Success deletes the redirect after the
new backend is live; retryable failure leaves it; and close can still mark it
cancelled while provider startup is pending. This keeps the ledger as the
visible ownership record across the same pre-entry/start awaits that previously
required cancellable compensation claims.

The seventh exact-head review keeps these responsibilities in the same two
substrates and rejects five partial call-site fixes. The ledger's active reclaim
is the source of truth for the predecessor-keyed backend currently being
restored, so close through any lineage identity must cancel that claim. Recovery
and reclaim generations carry a set of admitted renderer tokens rather than one
request's token. Workspace load joins the same persistence tail as saves. Path
proof treats cancellation as terminal after recording only evidence that was
actually proven. Redirect retargeting updates successor identity without
overwriting predecessor-specific restoration context. These are ownership,
generation, persistence, evidence, and alias-context invariants respectively;
none belongs in renderer timing or provider-specific exceptions.

The eighth exact-head review closes the final gap between those artifacts: a
reservation may not be retired merely because successor teardown finished when
its reclaim is about to publish predecessor restoration. It remains the
two-role close/tombstone authority until that nested claim settles. The
reservation also owns compensation directly, because successor failure can
start compensation without any renderer reclaim to carry the optional
reclaim-to-restoration link. Both associations remain in the ledger record;
provider lifecycle execution stays in `SessionManager`.

The ninth exact-head review adds a durability-settlement capability to the same
reservation rather than allowing overlapping P→S and S→T transactions. Once
P→S has produced a live S, an S→T request joins that capability until the
workspace save either commits P→S or retires it. This preserves P as the sole
durable fallback and avoids inventing partially overlapping reservations whose
close/reclaim semantics would need a second ownership graph. The renderer's
autosave remains the durability producer, but a failed attempt schedules a
latest-state retry; main never treats elapsed debounce time as proof of commit.

The tenth exact-head review keeps retry policy inside the existing autosave and
atomic-write substrates. The renderer owns one timer per mounted hook
generation plus a consecutive-failure counter; main owns cleanup of the unique
temp path created by one admitted save. Neither concern changes replacement
admission, the ledger, or provider lifecycle. A finite retry-count limit is
deliberately rejected because it would recreate the permanent durability wait;
the delay is exponentially increased to a cap while temp cleanup bounds disk
artifacts until persistence becomes healthy again.

This is separate from the async manager logic because the fifth review found
the same missing-identity failure in recovery, close, and transaction cleanup.
Adding three more scans/conditionals would preserve the substrate that produced
the bugs. A single ledger makes it impossible for one consumer to remember only
the predecessor key while another remembers both IDs.

### Stage 3 — route every same-pane replacement through the handoff

- [x] **Produces:** renderer replacement code that supplies the predecessor ID
  to main, preserves existing post-success state remapping, and leaves ordinary
  `spawn`/new-tab calls without replacement authority.
- **Verified by:** renderer tests assert the handoff field for `replaceSession`
  and its absence for fresh spawn; Reload Agent and Workflow MCP use the same
  central replacement path without one-off conditionals.
- **Why separate:** adding the main capability without routing the central
  renderer action would leave commands broken; adding command-specific fixes
  would duplicate policy across every MCP toggle and the reload command.
- **Reality check:** source inspection shows all affected capability toggles and
  Reload Agent already converge on `workspace.replaceSession()`.

### Stage 4 — integration verification and review

- [ ] **Produces:** passing focused tests, typechecks/build, a clean live Codex
  reload/MCP-toggle capture, and a pull request linked with `Fixes #638`.
- **Verified by:** the live capture shows the handoff begin/end nested inside
  successor provider start, successor readiness reaches ready, and no exact
  lease rejection occurs. Exact-head CI and review must be green.
- **Why separate:** unit ordering can be correct while preload wiring or real
  provider teardown remains wrong. The live recording verifies the physical
  lease is retired, not only that mocks were called in order.
- **Reality check:** the incident recorder already captures the lifecycle
  markers needed to compare the fixed run to the five failed attempts.

Both Stage 4 reviews are retained as Stage 2 evidence rather than patched
around. The first review proved eager teardown destroys rollback and that
`recover(oldId)` needs a fence. The second proved a fence without teardown
intent can resurrect a deliberately closed pane, direct `spawnWithId`
compensation is not cancellable during pre-entry awaits, an interrupted
recovery can retain the stable-ID generation fence after `stop()` returns, and
natural exit can remove the captured registry row before handoff executes.
Exact-head review must restart after the reopened Stage 2 lands; neither earlier
review can approve new transaction code.

The third through fifth reviews are retained for the same reason. The third proved
that stable local IDs require generation-scoped cancellation and a durable
renderer ownership commit. The fourth proved that the commit must itself be
totally ordered with workspace writes, and that reclaim needs a first-class
cancellable lifetime before ordinary recovery publication. Exact-head review
must restart after these artifacts land. The fifth additionally proved that a
token-addressable reclaim without active teardown, compensation association,
bidirectional identity, and retry classification is only partially cancellable.
The sixth and seventh reviews extend the same evidence: flattened aliases need
role-specific ownership and restoration context, close must follow the active
physical generation, proof cancellation cannot fall back to ordinary spawn,
loads must share persistence ordering, and joined renderer generations need
bounded cancellation authority. Every new implementation invalidates the prior
exact-head approval and requires another two-agent review.

## 3. Isolation boundary

The hard part is **same-transcript replacement admission and compensation**.
Provider execution remains in `SessionManager`, adjacent to backend ownership;
all replacement lifetime/index bookkeeping moves to
`src/main/sessions/codexReplacementLedger.ts`, consumed only by
`SessionManager`. Codex's
runtime receives only a one-shot callback at the exact point immediately before
resume ownership acquisition; it must not learn pane IDs, recovery policy, or
how compensation works. The renderer may declare intent by naming the local
predecessor; it may not decide that a rollout lease is safe to reuse.
`CodexHeadless`, the proxy adapter, QueueStrip, workflow UI, and individual
MCP-toggle commands are forbidden from importing or duplicating the handoff
policy.

The rollout coordinator remains a single consumer-independent safety layer. It
receives no pane IDs and gains no replacement exception.

## 4. Unknowns

- **Resolved in Stage 2:** a fresh Codex pane has no spawn-time resume ID, so
  main compares its observed transcript path with the provider registry's exact
  resolution of the requested ID. A regression test proves that evidence path
  performs the same stop-before-start handoff without trusting renderer state.
- **Resolved by revised Stage 2 design:** successor preflight cannot justify an
  eager predecessor stop. Main prepares the successor first, and a one-shot
  Codex callback invokes destructive handoff only at exact ownership acquire.
- **Resolved by revised Stage 2 design:** recovery of the predecessor local ID
  is fenced from initial admission through successor success or compensation.
- **Resolved by second-review Stage 2 design:** teardown intent is durable main
  state, not inferred from registry absence. Explicit close/shutdown cancels the
  replacement while the one internal predecessor stop carries transaction
  authority and does not cancel itself.
- **Resolved by second-review Stage 2 design:** compensation uses the same
  synchronously published, kill-visible `RecoveryClaim` substrate as ordinary
  stable-ID recovery and waits for a captured predecessor recovery claim to
  settle before attempting ID reuse.
- **Resolved by second-review Stage 2 design:** natural exit is proven by the
  captured registry generation's lifecycle marker and joined cleanup, never by
  a missing map entry.
- **Resolved by third-review Stage 2 design:** recovery cancellation is scoped
  by an opaque request generation, not the reusable ID/kind/cwd ownership tuple.
- **Resolved by third-review Stage 2 design:** successful spawn is not the
  renderer commit boundary. Workspace persistence acknowledges the new local
  ID; pending and recently committed handoffs retain enough main-owned routing
  evidence to restore the predecessor for a stale renderer without accepting a
  second rollout owner.
- **Resolved by fourth-review Stage 2 design:** unique workspace temp files
  prevent scratch-path collisions but do not order final renames. Main
  serializes the complete write/rename/acknowledgement critical section in IPC
  admission order.
- **Resolved by fourth-review Stage 2 design:** reclaim cancellation cannot be
  deferred until the final ordinary recovery claim because replacement
  settlement and successor stop are unbounded awaits. A separate reclaim
  generation is published synchronously and owns cancellation for the entire
  operation.
- **Resolved by fourth-review Stage 2 design:** reverse redirects have two
  relevant identities. Rehydrate enters by predecessor ID; explicit close may
  arrive by successor ID after natural exit. Main validates and retires the
  same redirect from either direction.
- **Resolved by fifth-review Stage 2 design:** pending successor start is not a
  passive wait once reclaim times out. The ledger associates the reclaim with
  its reservation; exact-token cancellation publishes reservation cancellation
  and starts authorized successor teardown immediately.
- **Resolved by fifth-review Stage 2 design:** compensation is a distinct token
  generation but not an unrelated operation. The reclaim record carries an
  explicit pointer to only the compensation claim it caused, allowing R to
  cancel C without reopening the earlier bug where an unrelated stale recovery
  token could cancel C.
- **Resolved by fifth-review Stage 2 design:** close is permanent for the current
  main-process lifetime, whereas deadline timeout is retryable. They are named
  cancellation classes rather than inferred later from a shared boolean.
- **Resolved by seventh-review Stage 2 design:** close through a successor or
  flattened alias addresses the active reclaim's predecessor-keyed recovery
  claim, not only the registry ID supplied by the renderer.
- **Resolved by seventh-review Stage 2 design:** a negative transcript proof
  removes handoff authority but does not erase close intent for the in-flight
  spawn request; cancellation still aborts ordinary-spawn fallback.
- **Resolved by seventh-review Stage 2 design:** workspace load participates in
  the save admission tail. Atomic rename protects file integrity, while tail
  ordering protects which renderer generation the loaded bytes represent.
- **Resolved by seventh-review Stage 2 design:** request tokens are join
  capabilities for one already-published generation. Generation-owned token
  sets preserve exact cancellation without making the first renderer immortal.
- **Resolved by seventh-review Stage 2 design:** flattened redirects share a
  physical successor but do not share predecessor restoration context. Cwd and
  launch facts remain attached to the alias that originally captured them.
- **Resolved by eighth-review Stage 2 design:** a pending reclaim entering its
  final predecessor recovery has not finished the replacement lifetime. The
  reservation stays published so either role can close the lineage and turn
  stale durable P bytes into a tombstone rather than a later resurrection.
- **Resolved by eighth-review Stage 2 design:** compensation ownership cannot
  depend on an optional reclaim. The reservation directly names the exact claim
  it caused, while a reclaim—when present—also names that same generation for
  token cancellation.
- **Resolved by ninth-review Stage 2 design:** a live successor is valid input
  to a later replacement before its local ID is durable, but it cannot safely
  start a second ownership transaction yet. The first reservation exposes one
  settlement capability: commit wakes the queued successor request, while any
  non-commit outcome cancels it. Renderer autosave retries failures using the
  latest state so this correctness wait also has a liveness path.
- **Resolved by tenth-review Stage 2 design:** `beforeunload` is an attempted,
  vetoable transition rather than proof the renderer will die. Its flush stays
  retry-capable while mounted-generation cleanup is the actual terminal event.
  Persistent errors retain eventual-success retries with capped backoff, and
  each failed main write removes only its own nonce-addressed temp artifact.
- Predecessor stop can fail or become uncertain. The coordinator's tombstone
  must remain fail-closed; compensation may also fail in that state and needs a
  truthful lifecycle outcome rather than an unsafe lease exception.
- A provider may emit exit/removal while renderer replacement is awaiting main.
  Existing generation/ownership guards should absorb that event, but the state
  remap must be checked rather than assumed.
- The incident journal currently records only the successor local ID. The
  smallest content-safe schema for predecessor/handoff outcome needs to be
  confirmed against the lifecycle emitter's allowlist.

## 5. Fixture plan

Stage 1 derives its event vocabulary, ordering, timing class, provider kind, and
failure boundary from the recorded #638 incident. Private local/provider IDs,
paths, prompts, and transcript contents are not fixture inputs. The fixture
keeps stable aliases (`predecessor`, `successor`) and the exact observed ordering
needed to prove the fix.

Additional negative cases are structural mutations of that recorded scenario:
different predecessor ID, different resume ID, and different provider kind.
They are not claims about unseen provider output; they prove that the narrowly
granted handoff capability cannot be widened into a general pre-spawn kill.

The first exact-head review adds three deterministic sequence fixtures at the
main-process boundary: predecessor-independent MCP registration failure,
recovery during the destructive handoff window, and successor start failure
after handoff. These are not imagined provider envelopes; each is a reachable
await/throw sequence traced in the committed manager and Codex runtime. The
tests assert ownership and compensation artifacts, not an invented UI result.

The second exact-head review adds four more deterministic sequences derived
from concrete await boundaries in the committed manager: explicit predecessor
close/global shutdown after destructive handoff; pane close while compensation
is blocked before registry publication; successor failure while the predecessor
belongs to a still-settling recovery generation; and natural predecessor exit
between replacement admission and the ownership callback. Each test controls
the exact promise boundary reported by review and asserts registry, provider,
MCP, and generation outcomes. The explicit-close companion proves that natural
exit handling cannot turn teardown into successor authorization.

Third-review fixtures add the two newly observed process-lifetime sequences:
(a) cancellation captured for recovery generation R is delivered only after
compensation generation C has published under the same stable ID; and (b) a
same-rollout successor becomes live but its spawn response is abandoned before
the renderer remaps/persists, after which a fresh renderer recovers the still-
durable predecessor ID. The second fixture also exercises stale predecessor
recovery immediately around durable successor acknowledgement. These tests
assert that C survives R's token and that exactly one backend remains reachable
under the durable renderer identity.

Fourth-review fixtures add four deterministic schedules taken from concrete
await boundaries in the reviewed head: (a) save A is admitted first and gated
before rename while save B is invoked; the final file and acknowledgement must
still reflect B; (b) reclaim publishes token T and waits for successor startup,
then exact-token cancellation arrives before startup settles; (c) redirect
reclaim removes its successor registry row and blocks in provider stop while
`killAll()` begins; and (d) a committed successor exits naturally and is then
explicitly closed by successor ID. The tests assert durable bytes, exact
acknowledgement order, cancellation truth, no post-deadline restoration, and no
post-close/post-shutdown resurrection. These schedules are not invented
provider data: each gates the precise promise boundary identified by the two
read-only reviewers against commit `026e9281`.

Fifth-review fixtures add eight schedules from exact commit `aa47225b`: (a) a
stop-aware successor start remains blocked until exact reclaim-token
cancellation actively calls stop; (b) successor failure starts compensation C,
then reclaim token R cancels that associated claim during preflight; (c) close
of committed successor B fences reverse `recover(B)` after registry removal;
(d) close of uncommitted successor B during predecessor reclaim cancels the
lineage; (e) close after destructive handoff but before commit is followed by
two stale predecessor recoveries, neither of which may construct a provider;
and (f) redirect reclaim token T1 times out, settles, and T2 successfully starts
a new reclaim; (g) acknowledged P→S→T flattening retains both reverse aliases
while P reclaim owns T; and (h) closing an unacknowledged S→T transaction also
tombstones the committed P→S ancestor. The fixtures preserve the distinction
between R-associated C and an unrelated old recovery token, and between
retryable timeout and durable close tombstones.

Sixth-review fixtures add three schedules from exact commit `ec4b2ac3`: (a) a
same-resume replacement changes cwd, commits, exits naturally, and is closed by
its successor ID/cwd before stale predecessor recovery; (b) committed P→S→T
receives synchronous reclaim requests through both P and S, proving one
physical-successor generation wins without mutual cancellation and that the
remaining alias follows the restored owner; and (c) a formerly fresh pane is
closed while real transcript-path resolution is gated, then a matching result
arrives and stale durable recovery remains cancelled. These are the exact
source-verified schedules reported by the two read-only reviewers, not new
provider shapes invented from the implementation.

The local post-review audit adds the directly adjacent fourth schedule: a
committed predecessor reclaim enters restored-provider start, explicit close
wins while that start is gated, and two later stale recoveries remain
cancelled. It is derived from the review's precommit-close invariant applied to
the redirect-to-recovery boundary; deleting the redirect before the await made
that boundary observably identical to the reviewed resurrection race.

Seventh-review fixtures add five source-verified schedules from exact commit
`a42c81a1`: (a) close the current successor, and separately a flattened losing
alias, after a reclaim has published and gated restored-predecessor start; (b)
close a formerly-fresh predecessor while transcript lookup is gated, then
resolve a different path; (c) admit a workspace save, gate it before rename,
then admit load and prove the read cannot overtake the save; (d) join a blocked
ordinary recovery and both pending/redirect reclaim shapes with a second token,
then cancel through that joined token; and (e) commit P(old cwd)→S(new cwd)→T,
then reclaim P and assert both provider creation and returned ownership still
use old cwd. Each fixture gates the precise promise boundary in the review
report and asserts the externally dangerous result—live hidden backend, stale
durable bytes, unkillable generation, or wrong-project restoration—rather than
an internal map shape.

Eighth-review fixtures add four schedules from exact commit `01bc47cc`: an
unacknowledged successful P→S reclaim is allowed to finish S teardown and enter
gated P startup, after which (a) joined token T2 cancels the physical claim,
(b) `killOwned(P)` stops it and fences a later durable-P recovery, and (c)
`killOwned(S)` does the same through successor ownership. The fourth schedule
makes S fail after destructive handoff, starts gated compensation without any
reclaim, and closes by S. These are distinct from the earlier fixtures that
closed while S was still starting/stopping or only after a committed redirect
existed.

Ninth-review fixtures add the one sequence independently reported by both
reviewers at exact commit `7a7bac32`: complete P→S, invoke S→T before the
debounced ownership save, and prove the second request remains pending rather
than rejecting or constructing T. A real ownership acknowledgement then wakes
the request and preserves stop-before-start ordering. Companion schedules
retire P→S while S→T waits and prove the queued request is cancelled, while a
renderer autosave fixture rejects its first real `saveWorkspace` call and
proves the timer retries from the latest state without another mutation. The
existing original-predecessor collision fixture remains the negative control.

Tenth-review fixtures add both exact schedules reported at commit `537294ab`:
(a) dispatch a cancelable `beforeunload`, veto it as the editor guard does,
reject the attempted flush once, and prove the surviving renderer retries from
latest state; and (b) keep rejecting autosave, prove retry delays grow from the
recorded 400 ms base, then unmount and prove no retired-generation timer fires.
The main IPC fixture lets `writeFile(tmp)` succeed and `rename(tmp, STATE_FILE)`
reject, captures the generated nonce path, and proves that exact path is passed
to `unlink` before the save rejection reaches its caller.
