# Per-pane runtime subscriptions

Status: implementation in progress. Refs #763. Base: main 5d641845.

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
