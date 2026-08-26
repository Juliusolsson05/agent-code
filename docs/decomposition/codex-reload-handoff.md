# Codex Reload Ownership Handoff

> **Status:** Stages 1–3 were implemented against the revised two-phase design.
> The third exact-head review exposed two more cross-generation/lifetime races:
> a delayed recovery cancellation can target the later compensation generation,
> and a successful successor can outlive the renderer that was supposed to make
> its random local ID durable. Stage 2 is reopened again. Its transaction now
> needs generation-scoped recovery cancellation plus a durable renderer-to-main
> ownership commit before the handoff record may retire. Stage 4 exact-head
> re-review, CI, and live verification remain.
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

## 3. Isolation boundary

The hard part is **same-transcript replacement admission and compensation**. Its
policy remains in `SessionManager`, adjacent to backend ownership. Codex's
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
