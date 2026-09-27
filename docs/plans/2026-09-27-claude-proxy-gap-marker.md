# Say where the Claude live feed lost proxy events (#1381)

Size: standard plan. The change crosses repos (claude-code-headless, then the
app). The cause is known; the gap's placement has a real design choice.

## Outcome

When the proxy transport loses generations of events
(claude-code-headless#64 `transport-gap`), the Claude feed stops showing
the surviving chunks as one continuous answer.
- The turn that was streaming across the gap is sealed.
- The feed shows a muted marker at that turn: **"Some live output was not
  captured"**.
- The saved transcript (JSONL, Claude's own file) is untouched and still
  fills in the full message as usual.

## Evidence (verified 2026-09-27, do not re-derive)

- **Today nothing consumes it.**
  - Package `ProxyServer.pollEventsOnce` emits
    `transport-gap {lostGenerations}`.
  - `ClaudeSession.attachProxyServer` re-emits it as
    `proxy-transport-gap`.
  - `SessionManager` records the `claude.proxy_transport_gap` incident
    and re-emits it, with no listener.
  - Proxy `event`s go to `headless.handleProxyTransportEvent` →
    `ClaudeProxyAdapter.handleTransportEvent`, the live streaming turn.
- **The gap is emitted at the wrong position.** `pollEventsOnce` emits
  `transport-gap` BEFORE every line of the poll, but
  `EventsFileTail.poll()` returns:
  - the held generation's tail;
  - then, on adopting a new live generation, `settleBelow` (which reads
    `.1` if still readable and counts the rest as lost);
  - then the new live lines.

  So the lost span sits between the old tail and the `.1`/live lines. One
  poll can settle twice: the first adoption, then a rotation. Emitting
  first would make the app seal before it applies the old tail. A pre-gap
  `request` would then create a flow AFTER the seal, whose chunks were
  lost, and it would stream corrupted with no marker.
- **The seal mechanism already exists.**
  - `ClaudeProxyAdapter.reapStaleActiveFlow(state, interruption)` publishes
    `turn_stopped {interruption}` + `finishTurn` + phase idle, and deletes
    the flow.
  - Chunks for a flow the adapter no longer tracks are ignored
    (`onChunk`: `if (!state) return`).
  - `sealFlowsSilentSince` (#963) and `onTransportError` (#1040) use it
    with `'system-suspended'` and `'transport-error'`.
- **App template: #1040 (`'transport-error'`, commits 4e799727 and
  b58bada3).** The interruption flows through:
  - `foldEvent.ts` (`turn_stopped` copies `interruption`);
  - `state.ts` (`SemanticTurn.interruption`);
  - `collectLedgerInput.ts` (`transportInterruptedTurnId` statics key);
  - `rendering/model/types.ts`;
  - `ledgerFeedItems.ts`, `feed/model/renderModel.ts`, and `Feed.tsx`
    (the `MarkerRow` "Interrupted before the response finished");
  - `rendering/observations/local.ts`, `replay/redact.ts` (the
    `interruption` key is allowed, as a closed enum), and
    `replay/invariants.ts`.

  The phone shares this pipeline.
- **Recordings.** Real Claude mitm events live in
  `~/.config/agent-code/proxy/**/proxy-events.jsonl` (`flow_id`,
  `chunk_b64`). They are private conversation content, so they are used
  only to calibrate frame shapes. No rotated `.1` files exist locally,
  because the packaged app predates #64's rotation. The package's adapter
  tests use synthetic SSE frames in the recorded shape
  (`ClaudeProxyAdapter.clientDisconnect.test.ts`), and so will these.

## Decisions (defaults taken; UNCONFIRMED until the manager or owner says otherwise)

1. **Wording:** "Some live output was not captured" (the issue's own
   example). It claims nothing about the transcript, which may well be
   complete. UNCONFIRMED.
2. **What gets sealed:** every flow the adapter is tracking at the gap
   point.
   - Streaming flows are sealed with the new interruption
     `'transport-gap'` (marker).
   - Tracked non-streaming flows (a request seen, no chunk yet) are
     forgotten without a marker, because their first chunks may be in the
     lost span. A decoder that starts mid-SSE would mis-assemble blocks.
   - **Cost:** the rest of such a response does not stream live; the
     JSONL row still lands.
   - Alternative rejected: resetting the SSE parser and continuing. The
     lost frames include `content_block_start`/`stop`, so block
     assembly after the gap is unreliable.
3. **The spinner after a seal:** the phase goes idle for the remainder of
   that one response, even though Claude may still be streaming it. The
   next request (the next tool round-trip) starts a new flow and a new
   phase. Same trade as #1040. UNCONFIRMED.
4. **Where the gap is placed:** at its true position in the line order,
   with a package change. We don't approximate it app-side.

## Change

### Package (claude-code-headless, its own PR; app pointer bump after merge)

- `EventsFilePoll` gains `gaps: Array<{ index: number; lostGenerations:
  number }>`.
  - `index` = the count of `lines` delivered before the lost span.
  - `lostGenerations` stays as the total (API compatible).
  - `settleBelow` records `out.lines.length` at entry, which is the
    position after the old tail and before `.1`/live.
- `ProxyServer.pollEventsOnce` emits lines and `transport-gap` interleaved
  at each gap's index. The payload stays `{ lostGenerations }`, per gap.
  The console.warn is unchanged.
- `ClaudeProxyAdapter.sealFlowsForTransportGap()` (public, synchronous):
  - streaming flows → `reapStaleActiveFlow(state, 'transport-gap')`;
  - every other tracked flow is dropped.
- `SemanticTurnStoppedEvent.interruption` adds `'transport-gap'`.
- API.md updated.

### App

- `ClaudeSession.proxyGapHandler` calls
  `this.headless?.proxy?.sealFlowsForTransportGap()` BEFORE re-emitting.
  The seal is synchronous, so the `turn_stopped` lands before any
  post-gap event.
- Renderer: `'transport-gap'` is added beside `'transport-error'` at every
  #1040 touchpoint:
  - `foldEvent`;
  - `SemanticTurn.interruption`;
  - `collectLedgerInput` (`gapInterruptedTurnId`, its own statics key);
  - the model types;
  - ledger items;
  - the render model;
  - `Feed.tsx` (a `MarkerRow` with the sentence above);
  - observations;
  - the redact enum and invariants.
- The submodule pointer is bumped to the merged package commit, with a
  lockfile resync.

## Tests (fail-first; each would fail before its fix)

- Package `eventsFileTail` test: a tail holding generation 0 with unread
  lines, then two rotations with the middle generation deleted. `poll()`
  returns the old tail lines, then `gaps: [{ index: <tail length>,
  lostGenerations: 1 }]`, then the live lines. Before the fix there is no
  `gaps` field.
- Package `proxyServer` test: the emitted `event` / `transport-gap` order
  equals the line order with the gap between them. Before the fix, the
  gap is emitted first.
- Package adapter test:
  - a mid-stream flow plus a gap gives `turn_stopped {interruption:
    'transport-gap'}`, `finishTurn` and phase idle;
  - its later chunks produce nothing;
  - a request-only flow is forgotten.

  Before the fix there is no such method.
- App `claudeSession` test: a proxy `transport-gap` seals before the
  re-emit (order pinned).
- App renderer: `foldEvent` keeps `'transport-gap'`, and the ledger/feed
  item renders the sentence. Pinned the way #1040's
  `ledgerFeedItems.test.ts` does it.

## Verification

- Package: `tsc` and vitest.
- App: `npx tsc -b` and the scoped vitest runs.
- Boundary: no live gap can be produced here. It needs >= 1 GiB of proxy
  traffic through a stalled poller, and the app is never launched. The
  path is pinned from the package event to the rendered row by tests at
  each boundary.

## Out of scope

- Codex's proxy (`codex-headless` responsesProxy) has no rotation or gap
  contract.
- The 1.2–1.4 GB unrotated `proxy-events.jsonl` files under
  `~/.config/agent-code/proxy` come from the packaged app predating #64.
  That is noted for the manager, not fixed here.

## Coordination

claude-code-headless#67 (another worker's, for #1380) also edits
`src/proxy/proxyServer.ts`, in different hunks (`startUnlocked`, options).
The two app pointer bumps must land in sequence. This was reported to the
manager before any package code was written.
