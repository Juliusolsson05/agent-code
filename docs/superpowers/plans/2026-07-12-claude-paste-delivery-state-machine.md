# Claude Prompt Delivery State Machine — Implementation Plan

Status: Implemented on PR #525; awaiting post-amendment review

Date: 2026-07-12

Branch: `fix/claude-paste-delivery-state-machine-plan`

Implementation update (2026-07-12): the initial review found that rich retry
semantics, images, session generations, remote deadlines, diagnostics, and
several adversarial inputs were still incomplete. The PR was amended to cover
those paths. The checklists below remain the historical implementation plan;
the regression suite and PR diff are the current source of truth.

## Goal

Make a finished Claude prompt submit exactly once even when Agent Code's
renderer is blocked for many seconds.

Here, “exactly once” is scoped to a live Agent Code/Claude process pair. A PTY
has no upstream idempotency key, so a process crash after Enter is written but
before JSONL acknowledgement can only be classified as uncertain; it cannot be
made exactly-once across restart without support from Claude. This plan makes
that crash boundary explicit instead of hiding it behind an automatic retry.

The correctness contract is:

> Once the renderer hands a finished prompt to main, renderer responsiveness
> must no longer affect whether that prompt reaches Claude.

The implementation must also distinguish these outcomes honestly:

- Claude accepted the prompt as a new user turn.
- Claude accepted the prompt into its queue while already working.
- Delivery failed before any prompt bytes reached Claude and is safe to retry.
- Prompt bytes or Enter may have reached Claude, but acceptance could not be
  confirmed; automatically retrying would risk a duplicate.

This plan replaces the desktop-only renderer paste choreography with one
main-owned, provider-owned delivery state machine. Remote, orchestration, and
desktop will use the same Claude delivery implementation.

## Why this plan exists

Issue #90 has survived several locally-correct fixes because each fixed a
different part of the protocol without making one process own the whole
transaction.

The current desktop path is split across:

1. React key handling.
2. Renderer-side debug hashing.
3. Renderer-to-main PTY IPC.
4. Main's headless terminal mirror.
5. Main-to-renderer screen events.
6. A renderer-side cached screen snapshot.
7. Renderer timers that decide when to send Enter.
8. Claude's JSONL tail, which is not currently part of the delivery verdict.

That shape cannot provide exactly-once delivery under renderer stalls. A late
timer from attempt A can submit the paste from attempt B because the PTY only
sees an untyped byte stream.

## Confirmed production evidence

The July 11 failure is not an inferred race. The paste journal and Claude's
authoritative transcript agree on the sequence.

Claude session:

- Agent Code session: `6fb1e0b0-f376-488d-8b78-750fffa1e2a0`
- Claude provider session: `86cf6025-7b3f-4e50-9dbd-ffa87dd91bbe`
- Claude Code version: `2.1.206`

Timeline:

| Time | Evidence |
| --- | --- |
| 11:44:23 | Renderer receives Enter for a 163-character prompt. |
| 11:44:31 | Paste reaches the PTY after an 8.190-second renderer delay. |
| 11:44:39 | User sends `.` because the prompt still has not submitted. |
| 11:44:39 | Claude JSONL records the original prompt with the extra dot appended. |
| 11:44:45 | The first operation's delayed detector finally sends Enter. |
| 11:44:45 | Two overlapping retries become duplicate Claude queue entries. |

The first paste therefore genuinely remained in Claude's composer. The dot was
not a second prompt; it appended to and submitted the stranded first prompt.

Across 313 recorded Claude paste-like submissions:

- Enter to paste: p50 17 ms, p95 38 ms, p99 154 ms, max 8,339 ms.
- Paste to Enter: p50 109 ms, p95 174 ms, p99 693 ms, max 13,784 ms.
- 307 used the absorption signal and six timed out.

This is a long-tail correctness failure under load, not a generally slow path.

## Confirmed isolated behavior

An isolated real-PTY reproduction used Claude Code 2.1.206, a fresh temporary
directory, the real `HeadlessTerminal`, and a local HTTP stub instead of the
Anthropic API.

Delayed case:

- The inline paste appeared in Claude after 202 ms.
- No API request occurred while Enter was withheld.
- Sending `.` plus Enter submitted successfully.
- The submitted prompt contained the extra dot.

Direct-buffer case:

- Polling `HeadlessTerminal.snapshotPlain()` detected the inline paste after
  97 ms.
- Sending Enter immediately after that confirmation submitted successfully.

This validates the intended boundary: direct main-side buffer observation
works; delaying confirmation outside main reproduces the user-visible failure.

## Historical drift to correct

The implementation history matters because the next change must not repeat it.

### May — correct execution plane, incomplete detection

PR #71 introduced main-side `awaitPastePlaceholder()`. It polled
`HeadlessTerminal.snapshotPlain()` directly and documented that the package's
screen event may stall under Claude's synchronized-output pressure.

The weakness was semantic: it detected only collapsed `[Pasted text #N]`
content. Inline pastes have no placeholder.

### June — complete detection, wrong execution plane

Commit `7505196` added placeholder-or-inline-tail detection. To avoid a
headless-package change, it ran against renderer-side `latestScreenRef`.

That fixed the missing inline signal but restored the screen-event and renderer
scheduling dependency that May explicitly warned against.

### July — shared predicate, still split ownership

Commit `9b0e58e` extracted the pure predicate to
`src/shared/claude/pasteConfirm.ts`.

Runtime/remote now uses that predicate against direct `snapshotScreen()`.
Desktop still uses it against renderer-fed `latestScreenRef`. The predicate is
shared, but the source of truth and scheduling environment still drift.

## Current defects this plan must close

1. `submitCurrentDraft()` has no synchronous in-flight guard.
2. The draft remains active until every asynchronous delivery step returns.
3. Renderer-side SHA calculation is awaited before the paste write.
4. Desktop confirmation polls a renderer cache rather than the live headless
   buffer.
5. That cache stores `recent` scrollback, not the active composer.
6. Repeated content can set `tailAlreadyPresent` from history and disable the
   inline signal for the entire attempt.
7. Desktop sends a blind timer-based Enter after detection timeout.
8. `submit:returned` means only that Agent Code wrote bytes; it does not mean
   Claude accepted the prompt.
9. The debug reducer labels every absorption timeout `stuck`, even when Claude
   later accepts the fallback Enter.
10. The image route remains an unconditional 750 ms timer.

## Design decisions

### Main owns the transaction

Desktop calls `SessionFeed.deliverPrompt()`. Main resolves the provider and
runs the provider-owned delivery protocol. Renderer `sendInput()` remains for
interactive keystrokes, terminal panes, condition answers, interrupts, and raw
debug terminal input; it is no longer the transport for a finished Claude
prompt.

### Main rejects concurrent delivery for one session

Do not queue a second implicit delivery behind an in-flight one. A repeated
Enter is almost always a retry caused by missing UI acknowledgement. Silently
serializing it would create duplicate prompts after the first eventually
succeeds.

Main is the authoritative lock. Renderer also keeps a synchronous ref guard so
the user receives immediate feedback without paying an IPC round trip.

### Direct xterm snapshots are the absorption source

Correctness polling uses `ClaudeSession.snapshotScreen()` / headless
`snapshotPlain()` inside main. It never waits for a `screen` event and never
reads renderer state.

### Active composer text is parsed separately from scrollback

The detector must operate on the bottom active input area, not an arbitrary
200-line history window. A prior identical user message must not poison a new
submission's baseline.

### JSONL or queue operation is the acceptance source

After Enter, acceptance requires one of:

- A matching Claude `type: "user"` entry.
- A matching Claude `queue-operation` with `operation: "enqueue"`.

Activity/spinner state is never a delivery verdict.

### No automatic retry after an ambiguous write

If prompt bytes or Enter may have reached Claude, an automatic retry can create
a duplicate. The result must carry `retrySafe: false`, and the UI must present
the uncertainty honestly.

### Diagnostics cannot delay delivery

No awaited hash, file write, debug IPC, or renderer journal step may occur
before the main delivery request is dispatched. Main can fingerprint received
content for correlation after it owns the request.

## Target state machine

```text
idle
  -> reserved
  -> acceptance_waiter_armed
  -> paste_written | plain_written
  -> paste_absorbed                 (paste route only)
  -> enter_written                  (paste route only)
  -> accepted_user | accepted_queue
  -> idle
```

Terminal outcomes:

```text
failed_before_write       retrySafe=true
absorption_timeout        retrySafe=false
acceptance_timeout        retrySafe=false
session_exited            retrySafe depends on whether a write occurred
cancelled_before_write    retrySafe=true
delivery_already_inflight retrySafe=true; do not send another copy
```

The delivery object records whether paste bytes and Enter were written. Retry
safety is derived from those facts rather than guessed from an error string.

## Proposed contracts

Add a shared result rather than continuing to overload `{ ok: boolean }`:

```ts
export type PromptAcceptance =
  | { kind: 'user'; entryId?: string; acceptedAt: number }
  | { kind: 'queue'; acceptedAt: number }

export type PromptDeliveryResult =
  | {
      ok: true
      acceptance: PromptAcceptance
    }
  | {
      ok: false
      stage:
        | 'reservation'
        | 'before-write'
        | 'absorption'
        | 'after-enter'
        | 'session-exit'
      code:
        | 'delivery-in-flight'
        | 'write-failed'
        | 'absorption-timeout'
        | 'acceptance-timeout'
        | 'session-exited'
      message: string
      retrySafe: boolean
      promptWritten: boolean
      enterWritten: boolean
    }
```

Keep transport protocol responses backward-compatible while widening internal
types first. Remote can initially map a rich failure to its existing error
string, then widen the remote wire in a dedicated compatibility commit.

## File map

Expected primary changes:

- `src/shared/types/providerConfig.ts`
  - Rich prompt delivery result and acceptance types.
- `src/shared/types/session.ts`
  - Typed Claude acceptance waiter capability if the capability remains on the
    neutral `AgentSession` contract.
- `src/shared/claude/pasteConfirm.ts`
  - Active-composer extraction and transition detection, or split those into a
    dedicated `composerScreen.ts` if keeping the pure predicate small is
    clearer.
- `src/providers/claude/runtime/claudeSession.ts`
  - Direct screen access already exists; add prompt-acceptance waiter plumbing.
- `src/providers/claude/runtime/promptDelivery.ts`
  - Main-owned state machine and conservative timeout behavior.
- `src/providers/claude/runtime/promptDelivery.test.ts`
  - Expand from mocked screen success into state-machine and acceptance cases.
- `src/main/sessionManager.ts`
  - Per-session delivery reservation and provider dispatch.
- `src/main/ipc/session.ts`
  - Return the rich result through `session:deliver-prompt`.
- `src/shared/sessionFeed/SessionFeed.ts`
  - Widen `deliverPrompt()` result.
- `src/renderer/src/features/sessionFeed/IpcSessionFeed.ts`
  - Pass through the widened result.
- `src/remote-client/src/WebSocketSessionFeed.ts`
  - Compatibility mapping or widened result after the protocol change.
- `src/providers/registry.renderer.capabilities.ts`
  - Put `deliverPrompt` into `ComposerSubmitIo` instead of providers reaching
    directly through `window.api`.
- `src/providers/claude/renderer/composerSubmit.ts`
  - Delegate text submission to main.
- `src/renderer/src/workspace/tile-tree/TileLeaf/useComposerKeybinds.ts`
  - Synchronous in-flight guard, UI lifecycle, retry-safe draft handling.
- `src/renderer/src/workspace/tile-tree/TileLeaf/claudePaste.ts`
  - Remove Claude text delivery after cutover; retain only genuinely shared
    helpers until Codex/image callers migrate.
- `src/main/pasteDebugJournal.ts` and the paste-debug event types
  - Record main-owned delivery phases.
- `src/renderer/src/features/debug/devModules/ClaudePasteDetection/timeline.ts`
  - Stop equating detector timeout with a confirmed stuck prompt.

Potential new files:

- `src/shared/claude/composerScreen.ts`
- `src/providers/claude/runtime/promptAcceptance.ts`
- `src/main/promptDeliveryCoordinator.ts`

Choose new files only if they make ownership more obvious. Do not add a generic
framework before a second provider needs the same semantics.

## Implementation sequence

### Task 0 — Pin the production failure as a regression test

- [ ] Add a deterministic test that holds the first delivery promise pending
      while invoking submit repeatedly.
- [ ] Assert only one provider delivery call occurs.
- [ ] Add a main-side test where renderer completion is irrelevant: dispatch
      delivery, do not resolve any renderer-side screen event, update the direct
      session snapshot, and assert Enter is written.
- [ ] Add a sanitized fixture representing the July 11 ordering without storing
      the user's original prompt.
- [ ] Assert a delayed Enter from attempt A can never submit attempt B because
      attempt B is rejected while A owns the session.

Why first: the exact failure is timing-dependent. Refactoring before pinning the
ordering makes it easy to produce another locally plausible but incomplete fix.

Suggested commit:

```text
test(claude): pin stalled-renderer and overlapping-submit regression
```

### Task 1 — Introduce rich delivery results

- [ ] Add `PromptDeliveryResult` and `PromptAcceptance` to the shared provider
      contract.
- [ ] Update Claude, Codex, and OpenCode runtime implementations to return the
      richer shape without changing their behavior yet.
- [ ] Thread the result through `SessionManager`, IPC, `SessionFeed`, and remote
      compatibility mapping.
- [ ] Make every failure declare whether retry is safe.
- [ ] Keep a temporary adapter for call sites that only understand `ok` while
      migrating them in subsequent tasks.

Why before behavior: the old boolean cannot represent “Enter was written but
JSONL acknowledgement is late.” Without the type, later code will collapse that
state back into either data loss or duplicate retry.

Suggested commit:

```text
refactor(prompt-delivery): model acceptance and retry safety
```

### Task 2 — Add authoritative per-session delivery reservation

- [ ] Add a main-owned map keyed by Agent Code session ID.
- [ ] Reserve before provider code writes anything.
- [ ] Return `delivery-in-flight` for a concurrent request; do not serialize it.
- [ ] Release in `finally` for every terminal path.
- [ ] Clear reservations during session removal/exit.
- [ ] Add tests for success, throw, timeout, exit, and concurrent requests.
- [ ] Add a renderer `useRef` guard before the first `await` for immediate UX.
- [ ] Record `duplicate-enter-blocked` when the renderer guard or main
      reservation rejects a repeat.

Why both guards: renderer gives immediate feedback; main is authoritative
across remounts, remote calls, orchestration, and future callers.

Suggested commit:

```text
fix(prompt-delivery): enforce one in-flight prompt per session
```

### Task 3 — Remove diagnostics from the critical path

- [ ] Dispatch main delivery before any async renderer diagnostic work.
- [ ] Stop awaiting `sha8Web()` before writing prompt bytes.
- [ ] Fingerprint the prompt in main after receipt, where Node's synchronous
      hash is cheap and cannot delay renderer-to-main dispatch.
- [ ] Correlate events with `deliveryId` plus phase ordinal; treat the hash as a
      forensic check, not transaction identity.
- [ ] Add a test whose debug sink never resolves and assert delivery still
      proceeds.

Suggested commit:

```text
fix(paste-debug): make diagnostics non-blocking for delivery
```

### Task 4 — Route desktop Claude text through main

- [ ] Add `deliverPrompt` to `ComposerSubmitIo`.
- [ ] Populate it from the active `SessionFeed` rather than using global
      `window.api` inside provider components.
- [ ] Change Claude text-only composer submission to call `deliverPrompt`.
- [ ] Preserve the current image branch temporarily; it migrates in Task 9.
- [ ] On rich failure, throw a typed error or return the result to the generic
      composer owner so it can apply retry-safe draft behavior.
- [ ] Verify remote and orchestration still hit the same main provider path.
- [ ] Delete renderer `getScreen` from Claude's composer IO once no provider
      needs it.

Exit criterion: no finished desktop Claude text prompt is assembled from raw
`sendInput()` calls in the renderer.

Suggested commit:

```text
refactor(claude): route desktop prompts through main delivery
```

### Task 5 — Build an active-composer screen detector

- [ ] Capture sanitized real screens for:
      - empty composer,
      - inline paste,
      - collapsed paste,
      - prior identical user message visible,
      - Claude working with queue composer,
      - narrow terminal wrapping,
      - permission/condition overlays.
- [ ] Implement a pure extractor for the bottom active Claude composer.
- [ ] Keep placeholder and inline detection scoped to that extracted region.
- [ ] Replace the global `tailAlreadyPresent` boolean with a composer transition
      comparison.
- [ ] Test two identical consecutive prompts.
- [ ] Test a matching tail in scrollback while the active composer is empty.
- [ ] Test a screen update that scrolls the prior user message while inserting
      the new composer text.
- [ ] Version fixtures by observed Claude version where the layout differs.

Why not occurrence counting over the full screen: scrolling can remove one old
occurrence while adding the new one, leaving the count unchanged. The active
composer is the state that matters.

Suggested commit:

```text
feat(claude): detect paste absorption in the active composer
```

### Task 6 — Move the full Claude paste protocol into main

- [ ] Capture the active-composer baseline directly from
      `ClaudeSession.snapshotScreen()`.
- [ ] For short safe plain input, preserve the provider's documented fast path.
- [ ] For paste-like input, write only the bracketed payload first.
- [ ] Poll the live headless buffer directly at the existing bounded cadence.
- [ ] Send Enter only after active-composer absorption is confirmed.
- [ ] Do not subscribe to `screen` events for correctness.
- [ ] Do not use renderer timers or state.
- [ ] Remove the desktop blind 500 ms plus 125 ms fallback.
- [ ] On absorption timeout, return `retrySafe: false` because the paste may
      already be present in Claude.
- [ ] Record every state transition with the main-owned `deliveryId`.

Suggested commit:

```text
fix(claude): own paste absorption and Enter sequencing in main
```

### Task 7 — Add authoritative acceptance acknowledgement

- [ ] Add a Claude prompt-acceptance waiter that observes the existing JSONL
      stream.
- [ ] Arm it before writing Enter so a fast JSONL entry cannot race past it.
- [ ] Capture a monotonically increasing ingest cursor before delivery and
      accept only entries after that cursor; a historical identical prompt must
      not satisfy the new waiter.
- [ ] Canonicalize line endings and Claude's string/structured user-message
      representation, but do not collapse arbitrary whitespace that could make
      different prompts compare equal.
- [ ] Resolve on an exact matching user entry.
- [ ] Resolve as queued on an exact matching `queue-operation/enqueue` entry.
- [ ] Keep a bounded recent-entry ring so an event arriving between setup steps
      can still be reconciled.
- [ ] Reject unrelated user entries and queue operations.
- [ ] Remove waiters on acceptance, timeout, session exit, and cancellation.
- [ ] Return `acceptance-timeout`, `retrySafe: false` after Enter was written.
- [ ] Do not automatically send another Enter or another paste on timeout.

Why exact acceptance matters: “Enter write returned” is transport success, not
Claude acceptance. This was the missing boundary in every previous diagnostic.

Suggested commit:

```text
feat(claude): confirm prompt acceptance from JSONL or queue entries
```

### Task 8 — Give the composer an honest pending/uncertain UX

- [ ] Add per-session delivery UI state: `sending`, `accepted`, `failed-safe`,
      `uncertain`.
- [ ] Disable Enter synchronously while `sending`.
- [ ] Keep the submitted draft snapshot separate from the editable next draft.
- [ ] Clear the submitted draft only after authoritative acceptance.
- [ ] Restore it automatically only for `retrySafe: true` failures.
- [ ] For uncertain post-write failures, show that Claude may already have the
      prompt and do not present an automatic resend button.
- [ ] Provide deliberate recovery actions, such as opening the raw terminal or
      copying the retained prompt, without silently writing more PTY bytes.
- [ ] Ensure pane remounts read main delivery state rather than losing the lock.

Suggested commit:

```text
feat(composer): surface pending and uncertain prompt delivery
```

### Task 9 — Migrate Claude image submission

- [ ] Move saving/normalizing image attachment paths behind the main-owned
      Claude delivery request, or define a typed attachment preparation step
      whose result main owns before PTY writes begin.
- [ ] Detect `[Image #N]` or an equivalent active-composer image-pill
      transition directly from the headless buffer.
- [ ] Remove the unconditional 750 ms image Enter timer.
- [ ] Confirm the final combined text-plus-image prompt via JSONL.
- [ ] Cover image-only, text-plus-image, multiple-image, missing-file, and slow
      image-expansion cases.

Why included: leaving images on a timer preserves the same class of bug in a
less common branch and prevents deleting the renderer paste machinery.

Suggested commit:

```text
fix(claude): move image prompt submission into delivery state machine
```

### Task 10 — Repair paste diagnostics

- [ ] Add main-owned events:
      - `delivery:reserved`
      - `acceptance:armed`
      - `paste:written`
      - `paste:absorbed`
      - `enter:written`
      - `acceptance:user`
      - `acceptance:queue`
      - `delivery:failed`
      - `delivery:uncertain`
      - `delivery:released`
- [ ] Record main monotonic durations separately from renderer dispatch delay.
- [ ] Update `ClaudePasteDetection/timeline.ts` so absorption timeout is not
      automatically classified as a confirmed stuck prompt.
- [ ] Define `submitted` as accepted user/queue evidence, not `submit:returned`.
- [ ] Retain backward parsing for old journals.
- [ ] Add a compact production metric for blocked duplicate Enter attempts and
      uncertain deliveries.

Suggested commit:

```text
fix(paste-debug): report authoritative Claude delivery outcomes
```

### Task 11 — Delete obsolete split-brain paths

- [ ] Delete renderer-side Claude text polling from `claudePaste.ts`.
- [ ] Remove `getScreen` from `ComposerSubmitIo` if no remaining provider needs
      it.
- [ ] Remove duplicated Claude paste thresholds and route predicates.
- [ ] Remove the desktop wall-clock fallback constants after image migration.
- [ ] Keep Codex atomic bracketed paste behavior provider-owned and unchanged.
- [ ] Update thick WHY comments to describe the final main-owned architecture.
- [ ] Update `docs/rendering/rendering-knowledge-dump.md` statements that
      incorrectly claim current polling is main-side.

Suggested commit:

```text
refactor(claude): remove renderer-owned prompt delivery residue
```

## Required automated tests

### Renderer safety

- [ ] Ten rapid Enter events while delivery is pending produce one request.
- [ ] Both textarea and global Enter paths share the same guard.
- [ ] A safe pre-write failure restores the draft.
- [ ] An uncertain post-write failure does not automatically resend.
- [ ] A pane remount cannot start a second delivery while main owns one.

### Main coordinator

- [ ] Reservation is acquired before provider dispatch.
- [ ] Concurrent delivery returns `delivery-in-flight` without writing.
- [ ] Reservation releases on success, every failure stage, and exit.
- [ ] A non-resolving diagnostic sink cannot block delivery.

### Claude absorption

- [ ] Inline 100–800 character prompt.
- [ ] Collapsed prompt over 800 characters.
- [ ] Four-line prompt.
- [ ] Dictation-shaped `<stt>...</stt>` prompt.
- [ ] Same prompt submitted twice consecutively.
- [ ] Identical tail in visible history.
- [ ] Narrow terminal wrapping.
- [ ] Condition overlay visible.
- [ ] Screen events completely absent while direct snapshots update.
- [ ] Absorption timeout writes no blind Enter.

### Claude acceptance

- [ ] Matching user JSONL resolves accepted.
- [ ] Matching queue enqueue resolves queued.
- [ ] Unrelated user and queue events do not resolve.
- [ ] Event arriving immediately after Enter is not missed.
- [ ] Acceptance timeout is marked retry-unsafe.
- [ ] Session exit cleans the waiter.

### Images

- [ ] Image-only prompt.
- [ ] Text plus one image.
- [ ] Multiple images.
- [ ] Slow image-pill expansion.
- [ ] Failed image save before PTY write is retry-safe.

## Required stalled-renderer integration gate

This is the release-blocking test because it models the production failure
rather than only the happy PTY protocol.

```text
1. Renderer dispatches one finished Claude prompt to main.
2. Renderer is blocked for ten seconds immediately after dispatch.
3. Main writes the paste.
4. Direct headless snapshot shows absorption.
5. Main writes Enter.
6. Claude emits exactly one matching user or queue JSONL entry.
7. Renderer resumes and receives the accepted result.
8. Repeated Enter attempts during the stall produce no additional PTY writes.
```

The test fails if any correctness step requires a renderer timer, renderer
screen event, or React state update.

## Manual PTY matrix

Run against the currently installed Claude and, when available locally, the
previous version implicated by the production transcript.

Use:

- Fresh temporary directories.
- Real `node-pty`.
- The real `HeadlessTerminal`.
- A local HTTP stub so no test prompt reaches Anthropic.
- Disabled hooks/plugins/MCP to isolate the TUI protocol.

Matrix:

- Short plain text.
- 100, 145, 163, 215, 799, 800, 801, and 2,000 characters.
- Two, three, and four lines.
- Dictation wrapper.
- Repeated identical prompt.
- Claude idle and Claude already working.
- Artificially blocked renderer.
- Artificially delayed main timer.
- Image-only and mixed image/text.

Record:

- Paste write time.
- Active-composer absorption time and signal.
- Enter write time.
- JSONL acceptance time and kind.
- Total writes for the delivery ID.

Do not promote the manual harness to a mandatory CI dependency on a user's
authenticated Claude installation. Keep deterministic protocol tests in CI and
use the real-PTY matrix as a release gate.

## Rollout

### Stage 1 — Shadow evidence

- Land rich results, main reservation, and new diagnostics while the old
  desktop path remains selectable in development.
- Run the production-shaped tests and compare main direct snapshots with the
  old renderer cache.
- Do not silently run both paths; shadow only observations, never PTY writes.

### Stage 2 — Desktop text cutover

- Make main-owned delivery the default for Claude text prompts.
- Keep a developer-only rollback switch for one release.
- Watch duplicate-enter-blocked, absorption-timeout, acceptance-timeout, and
  accepted-queue counts.

### Stage 3 — Images and cleanup

- Cut images over after their direct absorption signal is verified.
- Delete the renderer Claude paste state machine and wall-clock fallbacks.
- Remove the rollback switch after a full release without unexplained
  uncertain outcomes.

## Suggested PR slices

Keep the implementation reviewable even if development continues on one
stacked branch.

### PR A — Immediate safety

- Production-order regression tests.
- Renderer synchronous guard.
- Main authoritative reservation.
- Non-blocking diagnostics.
- No provider behavior cutover yet.

### PR B — Main-owned Claude text delivery

- Rich delivery result.
- `ComposerSubmitIo.deliverPrompt`.
- Desktop Claude text cutover.
- Active-composer detector.
- Direct headless-buffer absorption.
- Stalled-renderer integration gate.

### PR C — Authoritative acceptance and UX

- Cursor-bounded JSONL/queue acceptance waiter.
- Pending/accepted/uncertain composer state.
- Correct retry-safety behavior.
- Authoritative debug timeline.

### PR D — Images and residue deletion

- Image-pill confirmation.
- Delete renderer Claude paste delivery.
- Remove blind timer constants and stale documentation.
- Complete the real-PTY release matrix.

Each slice must preserve the main per-session reservation once PR A lands. Do
not temporarily restore overlapping writes to simplify a later migration.

## Acceptance criteria

The work is complete only when all are true:

- [ ] A blocked renderer cannot delay paste absorption or Enter after main has
      received the delivery request.
- [ ] Rapid repeated Enter cannot produce duplicate or crossed PTY writes.
- [ ] Desktop, remote, and orchestration use the same Claude delivery protocol.
- [ ] Inline and collapsed pastes use direct headless-buffer confirmation.
- [ ] Repeated identical prompts submit correctly.
- [ ] No Claude text or image path uses a blind wall-clock Enter fallback.
- [ ] The draft clears only after Claude user/queue acceptance.
- [ ] Every failure declares retry safety.
- [ ] Diagnostics never delay prompt bytes.
- [ ] The debug timeline distinguishes absorption, Enter write, and acceptance.
- [ ] The July 11 stalled-renderer ordering passes as an automated regression.
- [ ] The real-PTY matrix passes for the current Claude version.

## Non-goals

- Do not tune the 125 ms or 500 ms constants and call that a fix.
- Do not make spinner/activity state a submit verdict.
- Do not fix renderer performance as a prerequisite for prompt correctness.
  Renderer starvation is a trigger; delivery must remain correct despite it.
- Do not fork or patch Claude Code.
- Do not change Codex's provider-owned atomic paste protocol unless a separate
  Codex reproduction proves it is wrong.
- Do not automatically retry an ambiguous post-write result.

## Risks and mitigations

### Claude TUI layout changes

Active-composer parsing can drift across upstream releases.

Mitigation: versioned sanitized screen fixtures, a bounded failure result, and
JSONL acceptance as a separate authoritative layer. A parser failure becomes
visible and retry-aware rather than falling through to a blind Enter.

### JSONL tail delay

Claude may accept a prompt before Agent Code observes the entry.

Mitigation: arm before Enter, keep a recent-entry reconciliation ring, use a
bounded acceptance timeout, and classify timeout as retry-unsafe.

### Remote protocol compatibility

The remote wire currently expects a simple success/error reply.

Mitigation: widen internal contracts first and adapt rich failures to the old
wire until the remote client/server are upgraded together.

### Draft UX during uncertain delivery

Keeping the text in the active composer invites resubmission; clearing it can
look like data loss.

Mitigation: move it into explicit pending/uncertain delivery UI state. Preserve
a copy and recovery actions without leaving Enter enabled on the same text.

### Main-process pressure

Moving correctness into main does not make main immune to stalls.

Mitigation: direct in-process snapshots avoid renderer and screen-event delay;
the coordinator uses bounded state, one waiter per session, and no polling IPC.
Main pressure should still be measured, but correctness no longer spans two
event loops.

## Final verification commands

Run the focused tests first, followed by the normal gates:

```bash
npx vitest run src/providers/claude/runtime/promptDelivery.test.ts
npm run test:unit
npm run test:integration
npm run test:renderer
npm run build
```

Then run the real-PTY matrix and perform a manual Agent Code smoke test with:

- A long Claude response actively streaming in another pane.
- The renderer performance instrumentation enabled.
- A 100–800 character prompt.
- A multiline dictated prompt.
- Rapid repeated Enter attempts.

The smoke passes only if Claude records exactly one user/queue acceptance for
each deliberate submission.
