# Per-pane runtime subscriptions

Status: implemented; final checks/PR review in progress. Refs #763. Base: main 5d641845.

## Invariants and scope

Runtime-only updates and composer draft changes must not execute App or walk
unrelated tile trees. Layout/controller state remains React-owned; do not freeze
action closures. Commands and IPC must read the current store synchronously.
Session observers retain layout-effect ordering for lifecycle observations,
picker invalidation and autosave. Reader, headers and inspection surfaces must
continue subscribing to the state they paint. No lifecycle/readiness policy,
terminal mounting/resize ownership, screen transport or diagnostics policy change.

## Steps

1. Remove runtime-map and invisible draft-version invalidations from the root
   controller. Keep an immediately current imperative runtime read boundary.
2. Mount per-session runtime observers below the controller; keep autosave
   invalidation separate from pane painting. Preserve provider observation
   chronology, timers and teardown behavior.
3. Add per-session subscribed leaf boundaries and layout-only context access;
   migrate Reader, headers and other runtime consumers explicitly. Keep broad
   inspection surfaces reactive until narrowed individually, rather than
   silently rendering stale state.
4. Add deterministic render-count/freshness regressions, run relevant renderer
   suites, full typecheck and current CI. Record before/after counts rather than
   infer a CPU percentage. Open a complete PR; never merge without approval.

## Coordination

#808 independently fixes worktree projection/replay waste. #762 and #767 remain
subsequent independent increments; A6 owns #802–805. Older mixed experimental
worktrees are not edited or committed wholesale. Preserve root package-lock.json.

## Evidence and review boundaries

`runtimeIsolation.renderer.test.tsx` mounts the real workspace controller,
store, helpers, draft/autosave path and subscribed tile boundaries. It stubs
provider paint and external boot/event ingress so it cannot start live agents.
The control arm restores only the old root runtime-map subscription. For 100
committed single-session updates: controller and unrelated-pane renders are
100/100 in the control and 0/0 in the optimized arm; the affected pane paints
100 times in both. This is a deterministic invalidation measurement, not an
app-wide CPU or typing-latency claim.

Additional regressions cover synchronous draft reads before React commit,
debounced persistence and clear/undo, session replacement subscription routing,
fresh focus actions, late rendered-lease cleanup in Terminal mode, and exactly
once lifecycle publication before passive visibility with the retired run ID.

Review caught two cases beyond the earlier experiment: fresh inline arrays
would defeat a memo boundary, so leaf props are explicit; removing root runtime
renders also removes incidental lease cleanup, so hygiene now subscribes only
to picker/lease signals. Tab counts and related headers select painted status
values, while Reader subscribes to its chosen runtime.

Broad inspection/context consumers intentionally remain reactive; narrowing
individual debug/modal subscriptions further is not silently approximated.
No transport or backend processing changed. Local Node 25 exposes an incomplete
native localStorage without a backing file; renderer checks run with
NODE_OPTIONS=--no-experimental-webstorage so happy-dom owns storage, matching the
Node 24 CI environment. The initial run exposed this environment issue and four
outdated store/context mocks; production guards were not weakened to hide them.

Verification: full renderer run passed 115 files / 499 tests before adding the
last three regression cases; all six targeted isolation cases now pass. Final
full run: 501 passed, one timeout in the unchanged lazy-prose dynamic-import
test (existing #700), under substantially increased machine load (146.97 s
suite versus 24.52 s earlier). No retry policy, timeout, or test assertion was
weakened. Full typecheck, test contract and checked-in fixture privacy gates
passed during implementation; final typecheck and public CI tracked in the PR.
