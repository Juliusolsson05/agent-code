# Remote transcript store: a stale session list must not sever a live view

Status: planned; implementation follows on this branch.

Bug: [agent-code#847](https://github.com/Juliusolsson05/agent-code/issues/847).
Branch: `fix/remote-feed-list-eviction`. Worktree: `.worktrees/remote-feed-list-eviction`.
Base: `origin/main` at `1a82ca65` (2026-09-11). This plan is the first commit.

## Outcome

`WebSocketSessionFeed.integration.test.ts` stops failing intermittently in CI,
and the phone client stops silently losing a session view's history and live
entries when a session list arrives that predates the session. No timeout or
assertion changes; the integration test stays as the end-to-end proof.

## Root cause

`TranscriptStore` (`src/remote-client/src/transcript/store.ts`) handles every
`session-list` frame by deleting the state AND the listener set of every
session the list does not contain, then retrying backfill only for sessions
that still have state.

The server computes its handshake list at connection time and sends it after
`hello`. The client feed reports `open` on the socket's open event, before
those frames are parsed. A view that subscribes right after `open` (the
integration test; on the phone, tapping a session that just started, or any
reconnect) therefore races the handshake list:

- If the list frame arrived in the same TCP chunk as the upgrade response, the
  stream drains on `process.nextTick`, before the promise continuation that
  subscribes runs; the list evicts nothing, the later `started` patch finds a
  subscribed session and backfills. That is the passing order.
- If the list frame arrived in a later chunk, it is processed after the view
  subscribed and read its first snapshot. The empty list deletes the state and
  the listener set. The subsequent `started` patch finds no state, so nothing
  backfills, and later live entries are dropped because the session is now
  "unviewed". The view stays mounted and stays empty. That is both failure
  signatures on #847: `expected [] to have a length of 10` and
  `expected [] to deeply equal ['u-live']`.

CI load (coverage instrumentation, parallel jobs) widens the gap between the
upgrade response and the handshake frames, which is why the failure clusters
there and rarely reproduces locally.

A second, latent gap sits beside it: the retry hook iterates existing states,
so a session subscribed before it appears in any list, and never read through
`getSnapshot`, would never backfill either.

## Fix

In the session-list handler:

- Never delete listener sets. A view's subscription is owned by the view and
  ends only through the unsubscribe it was handed.
- Evict state only for sessions that are absent from the list AND unviewed.
  That keeps the retention guarantee from #805 (unviewed sessions hold
  nothing) while a mounted view keeps what it is showing; its own unsubscribe
  already resets the transcript when it leaves.
- Run the backfill retry over viewed sessions that are in the list, creating
  state lazily, instead of over existing states.

## Tests

- `store.sessionList.test.ts` (new, unit): the early-list race in both
  shapes. A subscribed session survives an empty list, backfills on the
  `started` patch, and still receives live entries; a subscribed session with
  no snapshot read yet backfills as soon as it appears in a list; an unviewed
  session absent from the list is still evicted.
- Existing `store.retention`, `store.reconnect` unit suites and the
  integration suite (system) pass; the integration suite is run repeatedly to
  confirm stability.

## Out of scope

Server-side ordering of the handshake frames. The client must be correct for
either arrival order because a reconnect can always deliver a list computed
before the newest session.
