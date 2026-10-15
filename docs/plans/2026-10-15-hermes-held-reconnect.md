# A held Hermes message survives a reconnect, and the client side leaves a trail

Size: short plan (root cause known). Fixes #1527. Package side: Juliusolsson05/hermes-headless#5.

## Evidence (verified, do not re-derive)
Hermes v0.22.0 server log, 2026-10-15 UTC, the owner's Telegram-thread pane:
socket drop 15:50:43 (1006) → reconnect 15:51:04 → `session.activate` 4001 (expected) →
`session.history` and `prompt.submit` on the OLD runtime 15:51:07/08 → 4001 → the pane
showed "Could not send your held message: <80 chars>". Every later send worked.
On our side nothing survived: `hold-failed` dropped its `error`, the dev app writes
only to the launching terminal, the packaged app keeps no log file. The cause was
found only from the server's log.

## Change
1. **Bump `packages/hermes-headless`** to hermes-headless#5 (attach barrier + one retry
   on 4001; RpcError/HermesPromptError carry the JSON-RPC request id). Source-only
   bump: the package's `package.json` is unchanged, so no lockfile resync.
2. **Held-message failure** (`hermesSession.ts`): the notice gives the reason and the
   FULL text (`Not sent (<reason>): <text>`), the same convention as Cancel, because
   main cannot write into the renderer composer.
3. **Client-side Hermes log** (`src/main/hermes/clientLog.ts`): one JSONL file per app
   at `~/.config/agent-code/hermes/logs/client.jsonl`, rotated once at 1 MiB (≤ 2 MiB
   on disk). UTC timestamps and the JSON-RPC request id, so a line matches Hermes'
   `rid=` line. Records: start ok/failed, connection connecting/ready/disconnected,
   reconnect attempt/ok/failed, held/released/hold-failed, refused direct sends,
   lane errors and moves, session replaced, turn lost, history errors, detach.
   Never message text (only its length): debug bundles get shared.

## Tests
- `clientLog.test.ts`: rotation at the cap keeps one previous file; a line carries a
  UTC timestamp and never a `text` field.
- `hermesSession` system test: a `hold-failed` carrying a refused HermesPromptError
  produces the reason + full-text notice and a log line with code and request id.
  Fails before the change (the notice was the 80-char excerpt, nothing logged).

## Review round (one Claude and one Codex reviewer; findings and fixes)
- **Package** (hermes-headless#5, commit `3623bd2`):
  - overlapping re-attaches now queue;
  - a 4001 waits for an attach already in flight;
  - a failed recovery is reported as not sent;
  - a lane retry re-resolves the tip;
  - a lane never creates a conversation on 4007;
  - "Send now" hands its text back through `hold-failed`.

  Details and tests: the package plan's Review round.
- **App:**
  - The `unknown` outcome (socket dropped after the submit went out) now reads "May not have been sent (…); check the chat before sending it again: <text>". "Not sent" invited a resend that runs the turn twice. Test: the lane system test with the socket closing on submit.
  - Outage lines are folded (`createOutageDeduper`). Each distinct line is written once per outage, and the count rides on `reconnected`/`started`/`detached`. Without this, ~70 KB/hour/pane rotated the incident's first lines out.
  - Error messages in the log are clipped to 300 characters, because a REST failure can quote a response body.
- **Not adopted:** none.

## Verification
`tsc -b tsconfig.node.json` + `tsc -p tsconfig.web.json --noEmit`, the touched tests,
then the full suite once. Not verified here: a real network drop against the VPS;
the app is not launched (owner rule).

## Out of scope
Putting the text back into the composer (needs a main→renderer composer channel;
follow-up if wanted). Adding the log to debug bundles (follow-up).
