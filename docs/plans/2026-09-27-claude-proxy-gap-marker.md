# Say where the Claude live feed lost proxy events (#1381)

Size: standard plan. The change crosses repos (claude-code-headless, then the
app). The cause is known; the gap's placement has a real design choice.

## Outcome

When the proxy transport loses generations of events
(claude-code-headless#64 `transport-gap`), the Claude feed stops showing
the surviving chunks as one continuous answer.
- The turn that was streaming across the gap is sealed.
- The feed shows a DURABLE row among the conversation, where the loss
  began: **"Part of this response was not captured (HH:MM:SS–HH:MM:SS)"**.
  - The row stays after later turns.
  - It comes back whenever the conversation's feed is rebuilt, within the
    lifetime of the main process (decision 5).
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
   - Ruling: the row is held by MAIN, in memory, per provider
     CONVERSATION (`TransportGapLedger`). It rides the conversation's
     initial history chunk, the load every feed rebuild makes: a window
     reload, an agent reload or crash respawn, a resume in another pane,
     live or exited.
     - Not on disk: the owner removed on-disk feed rows once (#1235 ghost
       log). The always-on `claude.proxy_transport_gap` incident is the
       on-disk record.
     - Bounded: the newest 50 gaps per conversation, and 500
       conversations (least recently recorded evicted).
     - Lost on an app (main process) restart.
     - Whether this bounded main-process lifetime is what option B
       approves is ASKED of B6 (steering q119) and recorded in the PR
       before READY.
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

### Package (claude-code-headless#69; app pointer bump after merge)

- `EventsFilePoll` gains `gaps: Array<{ index: number; lostGenerations:
  number }>`.
  - `index` = how many of the poll's lines were written before the loss.
    `settleBelow` records `out.lines.length` at entry.
  - `lostGenerations` stays as the total (API compatible).
- `ProxyServer.pollEventsOnce` emits lines and `transport-gap` interleaved
  at each gap's index.
  - The payload is `TransportGap = { lostGenerations, since, until }`
    (app-clock ms): `since` = when the previous poll completed (null
    before the first), `until` = now. It is exported.
  - The console.warn is unchanged.
- `ClaudeProxyAdapter.sealFlowsForTransportGap()` (public, synchronous):
  - a streaming turn → `reapStaleActiveFlow(state, 'transport-gap')`;
  - a flow with a first chunk but no turn yet → phase idle;
  - a turn that already stopped (awaiting its tool) keeps its phase;
  - every tracked flow is then forgotten.
- `SemanticTurnStoppedEvent.interruption` adds `'transport-gap'`.
- API.md updated.

### App

- `ClaudeSession.proxyGapHandler` calls
  `this.headless?.proxy?.sealFlowsForTransportGap()` BEFORE re-emitting
  the `TransportGap`.
- `SessionManager`:
  - on a gap: records the always-on incident (now with `since`/`until`)
    and appends a record to `TransportGapLedger`, keyed by the session's
    provider conversation id (`getNativeConversationId`; with none yet
    the record is live-only);
  - emits `proxy-transport-gap {sessionId, gap: TransportGapRecord}`;
  - `getTransportGaps(conversationId)`;
  - the ledger is NOT one of the caches cleared with the process.
- Wire:
  - `TransportGapRecord` lives in `@shared/types/session`;
  - `SessionHistoryChunk.transportGaps?`;
  - `SessionTransportGapEvent`;
  - the tap channel `transport-gap` (the desktop's `session:transport-gap`,
    and an additive remote protocol / phone wire channel);
  - `SessionFeed.onSessionTransportGap` on all four implementations.
- `session:load-initial-history` returns the conversation's gaps, only
  when there are any.
- Renderer:
  - `runtime.transportGaps`, fed by the live subscription (only onto an
    existing pane) and by `initialHistory.ts`, merged by record id
    (`mergeTransportGaps`);
  - `collectTransportGaps` makes one `provider-notice`-owner candidate per
    gap, contentKind `transport-gap`, at `since ?? until`, riding the
    notice candidates;
  - the feed item `transport-gap`, rendered as the existing muted
    `MarkerRow` (`transportGapSentence`);
  - `foldEvent` keeps `interruption: 'transport-gap'` on the sealed turn.
- The submodule pointer is bumped to #69's merge commit, with a lockfile
  resync if needed.

## Tests (fail-first; each would fail before its fix)

- **Package:**
  - `eventsFileTail.test.ts`: the gap position, no positions when nothing
    is lost, and the ProxyServer emit order plus `since`/`until`;
  - `ClaudeProxyAdapter.transportGap.test.ts` (5).
- **App:**
  - `claudeSession.suspension.test.ts`: event → seal → re-emit → event;
  - `sessionManager.proxyGap.test.ts`: the incident and record, held for
    the conversation across a respawn, not following the pane into a new
    conversation;
  - `transportGapLedger.test.ts`: the bounds;
  - `transportGapRow.test.ts`: the REAL adapter → fold → ledger → view
    bridge (seal, placement, persistence after later turns, rebuild merge,
    the sentence);
  - `initialHistory.renderer.test.tsx`: the loader restores gaps into a
    rebuilt runtime, once;
  - `useIpcSubscriptions.renderer.test.tsx`: the live event is held once
    per id and ignored for a pane that is gone.

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
manager before any package code was written, and the manager cleared it.

HOLD (steering q119): #1442 stays out of integration until #69 merges.
Then: repoint the submodule to the merge commit, resync the lockfile if
needed, run exact-head CI, and run three independent reviews.

Residual surfaces outside this PR, filed:
- #1443: the phone does not paint the row yet;
- #1444: recordings do not capture the channel.

## Execution notes

- Package: claude-code-headless#69 (`8be9a7a` on `fix/proxy-gap-position`)
  - `EventsFilePoll.gaps`, the in-order `transport-gap` with
    `{since, until}`, `sealFlowsForTransportGap`, and the `'transport-gap'`
    interruption;
  - the full suite passes 205/205;
  - two mutations are caught (all gaps emitted first; a stopped turn
    sealed too).
- Ruling (superseded an earlier draft that held gaps per session and reseeded them over an IPC like conditions; the Change section now describes the result): main's
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
