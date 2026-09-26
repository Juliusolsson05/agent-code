# A fresh Pi pane's first prompt waits for its bridge (#1315)

## Evidence
- On 2026-09-25, 5 of 5 `orchestration_create_agent` calls with `kind: "pi"` returned `prompt_delivery_failed … the Pi bridge is not connected`.
- An `orchestration_send_prompt` of the same text to the same session, seconds later, succeeded every time.
- Codex and Grok children spawned in the same batches bootstrapped fine.

## Cause
- `PiSession.deliverPromptText` → `PiTerminalHeadless.submitPrompt` answers `no-live-channel` immediately while the bridge extension is still connecting.
- The package settles that race itself: `live-state` reports `connected`, or `bridge-unreachable` after `bridgeConnectDeadlineMs` (30 s by default), or `bridge-listen-failed`.
- Codex's delivery already waits (up to 15 s, `awaitReadyForPrompt`). Pi's does not.

## Change (app only)
- `PiSession` keeps a per-start flag, "bridge startup settled". It becomes true on the first `connected`, on `bridge-unreachable`, on `bridge-listen-failed`, on exit and on stop.
- `deliverPromptText` waits for that flag before the first connect only, with a hard cap a little above the package deadline. After that, a disconnect fails fast as before, so a bridge that dropped mid-session is reported and not waited on.
- Nothing is pasted into the TUI (#877). A bridge that never connects still fails `not-ready`, with the existing `provider_bridge_unreachable` banner.

## Tests
- Replay rig: a delivery started before the replayed bridge connects reaches the bridge (the rig answers the request) instead of failing "not connected". Red on main.
- The existing no-bridge test still refuses `not-ready`, after the (test) deadline.
