# Resuming in place from the Conversations picker must say when it fails (#1241)

## Verified failure
`ConversationsPicker.resume` closes the picker, then awaits `workspace.replaceSession(...)`. Its callers fire it with `void`. Two outcomes then disappear:
- **A rejected swap** (the recorded `posix_spawnp failed` spawn error was used) became an unhandled rejection. The existing renderer test harness reports it as one.
- **An `undefined` return** (no command target, missing meta, a refused commit) was silent.

In both cases the user saw nothing change.

## Design
- The target pane is read before the picker closes. Every failed outcome is reported on that pane with a toast, the way `builtInMcpReload` reports the same call. A thrown message is shown as-is; `undefined` gets "Couldn't resume <label> in this pane."
- With no pane to resume into (reachable only in "everywhere" scope), the picker stays open and says so inline instead of closing into a no-op.

## Tests
Renderer tests with the recorded spawn failure, the `undefined` outcome, and the no-target case. Red on main (unhandled rejection, no toast); each branch is mutation-checked.
