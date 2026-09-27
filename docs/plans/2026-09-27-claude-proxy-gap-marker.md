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

## Decisions (5 is OWNER-APPROVED; 3 is still UNCONFIRMED; the rest are rulings)

1. **Wording:** superseded by decision 5.
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
5. **How long the marker stays: OWNER-APPROVED (B6 proxy, 2026-09-27):
   option B**, a DURABLE feed-history row (temp/manager/assign/w3-1381-decision.md).
   The owner's rule is that data loss is never hidden. A work-slot marker
   (option A) would vanish once the agent worked again, so it would hide
   the loss from anyone reviewing later. The row reads **"Part of this
   response was not captured (HH:MM:SS–HH:MM:SS)"** and supersedes the
   decision-1 wording. It persists after later turns and survives a
   renderer reload. It is one row kind, adds no new UI surface, and uses
   the existing muted MarkerRow styling.
   - Ruling: the row is held by MAIN in memory, per session. It is not
     written to disk: main outlives a renderer reload, which is the
     rebuild the decision names. On-disk feed rows are what the owner
     removed in #1235 (the ghost log). The always-on
     `claude.proxy_transport_gap` incident is already the on-disk record.
     Cost if wrong: after an app restart, the row is gone (the incident
     stays).
   - Ruling: the span is app-clock time, from `since` (when the tail was
     last caught up, i.e. the previous poll that completed) to `until`
     (when the gap was detected). Wire events carry no timestamp, and the
     lost events were written inside that window. Cost if wrong: the
     window is wider than the true loss, never narrower.
   - Ruling: the #1040-style work-slot marker from 91b05b03 is withdrawn
     (one row kind). The fold still keeps `interruption: 'transport-gap'`
     on the turn, so the sealed turn reads as cut off rather than
     finished.

## Change

### Package (claude-code-headless, its own PR; app pointer bump after merge)

- `EventsFilePoll` gains `gaps: Array<{ index: number; lostGenerations:
  number }>`.
  - `index` = the count of `lines` delivered before the lost span.
  - `lostGenerations` stays as the total (API compatible).
  - `settleBelow` records `out.lines.length` at entry, which is the
    position after the old tail and before `.1`/live.
- `ProxyServer.pollEventsOnce` emits lines and `transport-gap` interleaved
  at each gap's index. The payload becomes `{ lostGenerations, since,
  until }` (app-clock ms): `since` = when the previous poll completed (the
  tail was caught up then; null before the first), and `until` = now. The
  console.warn is unchanged.
- `ClaudeProxyAdapter.sealFlowsForTransportGap()` (public, synchronous):
  - streaming flows → `reapStaleActiveFlow(state, 'transport-gap')`;
  - every other tracked flow is dropped.
- `SemanticTurnStoppedEvent.interruption` adds `'transport-gap'`.
- API.md updated.

### App

- `ClaudeSession.proxyGapHandler` calls
  `this.headless?.proxy?.sealFlowsForTransportGap()` BEFORE re-emitting.
  The seal is synchronous, so the `turn_stopped` lands before any
  post-gap event. The re-emit carries `{ lostGenerations, since, until }`.
- `SessionManager`:
  - on a gap, also appends a record to a bounded, per-session,
    in-memory list (`TransportGapRecord = { id, since, until,
    lostGenerations }`; the cap is the newest 50);
  - emits `transport-gap {sessionId, gap}`;
  - clears the list with the session's other cached state
    (`cleanupSessionState`);
  - `getTransportGaps(sessionId)` answers the reseed.
- IPC:
  - `session:transport-gap`, forwarded by the session feed tap like
    `session:conditions`, so the phone gets it too;
  - `session:reseed-transport-gaps(sessionIds)`, mirroring
    `session:reseed-conditions`: the owning window gets every held record
    re-sent on the live channel.
  - Preload and `SessionFeed.onSessionTransportGap` are added to both
    transports.
- Renderer:
  - the runtime holds `transportGaps: TransportGapRecord[]`, de-duplicated
    by `id` because a reseed replays records already held;
  - `collectLedgerInput` turns each record into a committed-plane
    candidate with `timestampMs = since ?? until`, ordered among entries
    like a provider notice;
  - one row kind, `transport-gap`, rendered as the existing muted
    `MarkerRow`: "Part of this response was not captured (HH:MM:SS–HH:MM:SS)";
  - `foldEvent` keeps `interruption: 'transport-gap'`, with the model
    types, invariants and redact to match;
  - the reseed runs where conditions are reseeded.
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
- App `SessionManager`: a gap is recorded, bounded, returned by
  `getTransportGaps`, and cleared with the session.
- App end to end (the `turnClockAcrossSleep.test.ts` harness, driving the
  REAL package adapter into the reducer and feed items): a gap mid-stream
  seals the turn, and the durable row sits at its time among the entries.
  It STAYS after a later turn completes, and it is back after the runtime
  is rebuilt from a reseed (the reload).

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

## Execution notes

- Package: claude-code-headless#69 (`8be9a7a` on `fix/proxy-gap-position`)
  - `EventsFilePoll.gaps`, the in-order `transport-gap` with
    `{since, until}`, `sealFlowsForTransportGap`, and the `'transport-gap'`
    interruption;
  - the full suite passes 205/205;
  - two mutations are caught (all gaps emitted first; a stopped turn
    sealed too).
- Ruling (supersedes "held per session" and the reseed IPC above): main's
  `TransportGapLedger` is keyed by the provider CONVERSATION id, and the
  records ride `session:load-initial-history` (`SessionHistoryChunk.transportGaps`).
  - Every feed rebuild goes through that load, whether the window reloads,
    the agent reloads or respawns after a crash, or the conversation is
    resumed in another pane, and whether the pane is live or not.
    Conditions-style reseeding would only cover live backends.
  - A new conversation in the same pane (Claude /clear) does not inherit
    the old row.
  - With no conversation id yet, the row is live-only. This can't happen
    in practice: a gap needs >= 1 GiB of the session's traffic.
  - Cost if wrong: none found. It is one optional chunk field.
- Ruling: no new RenderOwner (the model says adding one needs plan review).
  - The row is a `provider-notice`-owner candidate with contentKind
    `transport-gap`, riding the notice candidates, so the ledger input
    keeps its shape and ordering follows the notice contract ("status
    follows equal-time conversation").
  - It is placed at `since ?? until`. A gap older than every loaded entry
    shows at the top of the window instead of being withheld.
- Ruling: the phone (remote client) relays the channel but does not paint
  the row yet. The phone keeps its own TranscriptStore, and wiring it is a
  separate surface. Follow-up issue to file.
- Ruling: the time text uses 24-hour HH:MM:SS from Date getters, not
  `toLocaleTimeString`, so the one visible sentence can be tested.
- Tests: package 205/205. App:
  - ClaudeSession seal order;
  - SessionManager: incident, record, held for the conversation across a
    respawn, not following /clear;
  - the ledger bounds;
  - the end-to-end row (real adapter → fold → ledger → view bridge):
    placement, persistence after later turns, the rebuild merge, and the
    sentence;
  - the loader restoring gaps into a rebuilt runtime;
  - the live subscription.
  - Mutations caught: bridge drop, missing candidates, the fold dropping
    the interruption, history ingest dropping the gaps.
