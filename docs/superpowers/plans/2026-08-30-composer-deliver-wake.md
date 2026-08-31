# Composer delivery: wake the backend main says is gone

Fixes #706.

## Problem

After an app restart, a restored pane (tile leaf or a Grid Dispatch lane's
restored selection) accepts a prompt, but main holds no live registry entry for
the session id, so `deliverPromptToAgent` rejects at `before-write` with
`code: 'not-ready'` — journaled as `reason: "never-owned"` (an id main never
spawned this run) or `"entry-lost-after-owned"` (a teardown the renderer
missed). The user sees `Cannot deliver prompt: <id> is not a live agent
session` on a pane that looks perfectly healthy. Recorded in debug bundle
`2026-08-30T23-51-06-471-9bd68e14` (sessions `82fa0abe…`, `39e22d50…` — the
latter verifiably a previous app run's id restored from workspace.json).

## Why the existing wake sites miss it

- `rehydrate.ts` deliberately does not respawn detached sessions; the wake is
  supposed to happen at first use.
- `TileLeaf.send` wakes — but only the RAW-WRITE path. Claude/opencode composer
  submits go through the provider delivery protocol (`feed.deliverPrompt` →
  `deliverPromptToAgent`), which never touches `send`. (Codex submits are raw
  `send` calls and are therefore already covered.)
- #691's `selectTiledLaneSession` wakes on lane *placement gestures* — a
  restored workspace re-establishes lane selections without any gesture, so
  the first thing to reach the dead backend is Enter in the composer.

## Design: react to main's verdict, don't second-guess renderer state

The renderer's runtime can be exactly wrong here (that is what registry
split-brain means), so a proactive renderer-side liveness gate would trust the
component that is already mistaken. Main's reject is the authoritative signal
and is already shaped for recovery: `{ ok: false, stage: 'before-write',
code: 'not-ready', retrySafe: true, disposition: 'session-unusable' }` proves
nothing was written and the session needs repair.

New `TileLeaf/deliverWithWake.ts`: run the delivery; on exactly that shape,
`ensureSessionLive` (same-SessionId recovery — joins any in-flight wake, keeps
every Dispatch/pin/orchestration reference valid) and retry the delivery ONCE.
A failed wake, or any other failure shape, surfaces the original result
untouched — the existing unwind/toast/uncertain-banner machinery stays the
single owner of failure UX. Wired at the one kind-agnostic call site, the
`deliverPrompt` wrapper in `useComposerKeybinds`.

`WAKE_CALLERS` gains `'tile-leaf.deliver-retry'`, parallel to
`'tile-leaf.send-retry'` (the raw-write twin), so the lifecycle journal can
tell a delivery-path recovery storm from a send-path one.

## Tests

`deliverWithWake.test.ts` pins the contract: reject → wake → second delivery in
that order, returning the retry's result; wake failure → original reject
surfaces with no second delivery; non-matching failures (acceptance-timeout,
do-not-retry, delivery-in-flight) → no wake, single delivery; a second
matching reject → returned as-is, never a third attempt. Wiring inside
`useComposerKeybinds` is a one-line call at the single delivery site; the
helper tests pin the behavior, not the hook plumbing.

## Out of scope

The trust-dialog regression (#705, PRs open) — the other producer of this
error message via `entry-lost-after-owned`.

## Verification

`tsc` node + web; helper suite plus the adjacent composer/streaming suites
under `NODE_ENV=development`.
