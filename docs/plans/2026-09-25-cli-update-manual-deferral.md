# "Update now" with a running agent must say why nothing happened (#1243)

## Verified failure
`CliUpdateOrchestrator.updateOnceInner` (the manual "Update now" path) records `deferred` / `session-active` when `acquireUpdateLease` fails. That lease fails whenever any live session of the CLI exists, which is the normal case. `CliUpdateBanner` renders `deferred` as nothing, by design for the automatic path. So the click made the banner vanish with no update and no reason.

## Design
- **Mark the manual deferral:** it records `requestedByUser: true` on the `deferred` state; the automatic path is unchanged and stays silent.
- **Render only that case:** the banner shows "<CLI> <version> is ready, but <CLI> agents are running. Close them to update (now <installed>)." It is dismissable like every banner row (the dismiss key is derived from the state's identity).
- **Out of scope:** the other silent returns the issue lists (binary missing, version unreadable) leave the `notify` banner in place, so the banner doesn't vanish. They are unchanged here.

## Tests
- The orchestrator's manual path with the lease held records the flagged deferral.
- The banner explains it, and the automatic deferral stays silent.
- Every change is mutation-checked.
