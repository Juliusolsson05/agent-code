# Queued Prompt Visibility Implementation Plan

> Status: IMPLEMENTED on `fix/queued-prompt-visibility`. Fixes #889 and #890. §6 records the verification. §7 records the first review round (2026-09-12) and what it changed in D1–D5.

**Goal:** When Claude accepts a prompt into its queue instead of starting a
turn, the pane must tell the truth about it: the WorkIndicator keeps showing
what the running turn is doing, and the queue strip shows the queued prompt
even if the user collapsed the strip during an earlier queue episode.

**Architecture:** Three small, coupled changes in the renderer plus one
type-level change in the provider capability contract. No main-process change.
No rendering-pipeline change: the durable queued-prompt row shipped in #665
already paints the prompt when Claude drains it.

**Tech Stack:** TypeScript, React 18, zustand app store, Vitest 4 (`unit` and
`renderer` projects, happy-dom).

---

## 1. What the investigation established (evidence, not inference)

Recorded incident: agent `35a552fe` / Claude session `ededdea8`, 2026-09-11,
app run `2026-09-11T02-29-42-498Z-main-63119-fdfc2a`, build `95e37bf4`.

| Local time | Source | Fact |
|---|---|---|
| 10:02:38.907 | paste-debug `181e3d52` | Enter on 225 chars + 1 image; `beginOptimisticSubmit` stamps `streamPhase: 'submitting'` |
| 10:02:39.115 | paste-debug | main: `delivery:acceptance-queue` (Claude was mid-turn, `thinking_delta` every ~1 s) |
| 10:02:39.117 | paste-debug + lifecycle | renderer success path completes, `submit.result ok 210ms` |
| 10:02:39.120 | feed-debug | `enqueue` op folded, `queuedMessages: 1`, no feed row (by design, the strip owns pending prompts) |
| ~10:03:06 | user screenshot | `Sending · 27s`, strip header `1 QUEUED ▴ show` (collapsed), no prompt visible anywhere |
| 10:03:25.038 | feed-debug | first `stream_phase` event since submit; indicator leaves `Sending` after 46 s |
| 10:06:09.724 | Claude transcript | `queue-operation remove` (mid-turn drain) |
| 10:06:09.876 | feed-debug RENDER | durable row `entry:3b4034c6…` (`attachment/queued_command`) painted by the #665 path |
| 10:09:42 | paste-debug `7413cb56` | user re-sends the same 225 chars plus 90 more |

Same shape on 2026-09-01 (session `99b4657b`): queue acceptance at 00:18:11Z,
drain at 00:18:32Z, identical 590-char prompt re-sent at 00:18:35Z. Across
1,714 recorded submits a same-text re-send followed a queue acceptance 2/365
times versus 1/670 for user acceptances.

**The composer clear is not the defect.** `submitCurrentDraft` clears text and
images after `composerSubmit` resolves; a harness driving the real workspace
controller and the real hook with a fake feed answering `queue` acceptance
clears both. Every writer of `workspaceRuntimes` is a functional updater, the
`latestRuntimesRef` is refreshed by a `subscribeWithSelector` subscription, and
Chromium (verified in Chrome 152 with real keystrokes) keeps no textarea undo
history across a programmatic clear. No PTY-forwarded key was pressed between
the two submits. How the text came back into the composer in the two incidents
cannot be recovered from the logs; the most economical explanation is a paste
after the prompt appeared to vanish. This plan fixes the vanishing.

Two defects remain, both verified from the logs:

1. **Stuck `Sending` (#889).** `beginOptimisticSubmit` overwrites the live
   phase before delivery. A queue acceptance starts no turn, so no
   `turn_started` bridge fires, and `reduceStreamPhase` deliberately never
   stomps `submitting` from screen signals. The indicator lies until the
   running turn's next `stream_phase` event: 21 s at 09:59, 46 s at 10:02.
   `claudeComposerSubmit` receives `result.acceptance` and throws it away.
2. **Collapsed strip persists (#890).** `QueueStrip` keeps `collapsed` in
   component state and stays mounted (returns `null`) while the queue is
   empty, so one "hide" click hides every later queue episode's preview.

## 2. Design decisions

### D1 — Do not stamp the optimistic phase over live work

`beginOptimisticSubmit` is the only writer of the optimistic `submitting`
phase. It skips the stamp when the submit lands on work the provider is still
doing. The predicate is `submitJoinsLiveWork` in `hook/actions/streaming.ts`,
true when any of these holds:

- the semantic turn is running (`isSemanticTurnRunning`);
- the phase is non-idle and is not `awaiting-tool`;
- the phase is `awaiting-tool` AND the mounted semantic turn still has a
  pending tool (`hasPendingSemanticTools`).

Painting `Sending` there is a lie from the first frame. In that branch the
action still clears `pendingRewindUndo` and appends the `submit started`
feed-debug row (with a `behind a live turn` note). It leaves `streamPhase`, `turnStartedAt`, `phaseChangedAt`,
`submittedAt` and `awaitingAssistant` untouched and returns no stamp token
(D2). The indicator keeps showing the running work's real phase and its real
elapsed time.

*Why not restore the prior phase after the fact:* restoring needs the prior
five fields stashed somewhere; a new `SessionRuntime` field for that would ride
into every debug bundle and every runtime spread for a value the UI never
reads. Not painting the lie is simpler than repainting the truth.

*Why the gate is right for every provider (review F2).* Every composer
shares this action:

- **Claude** queues a mid-turn prompt (acceptance `queue`), and no turn starts
  for it.
- **Codex's** composer writes raw PTY bytes and returns no acceptance. Its
  running turn's own `stream_phase` events are the truth the stamp would hide.
- **OpenCode** reports `transport` for every successful HTTP handoff, so the
  renderer cannot tell a held prompt from a started turn. Over a live turn the
  live phase is accurate either way.

Losing the stamp's `awaitingAssistant: true` changes almost nothing, because
the running turn's next semantic event clears it. Orchestration and agent
management read `streamPhase !== 'idle'`, which the live phase already
satisfies.

*The `awaiting-tool` tradeoff (review F2).* The review proposed stamping again
when the phase is `awaiting-tool` with no running semantic turn. That is the
documented Codex shape after `turn_completed`, where a submit may start a
turn. As a literal rule it is wrong:

- Both adapters close the proxy turn at the response boundary, and only then
  publish `awaiting-tool` while the client runs the tool. That is
  `ClaudeProxyAdapter` at `message_delta` and `CodexResponsesAdapter` at
  `response.completed`.
- The fold keeps the ended turn mounted while its tool is pending.
- So "awaiting-tool with no running turn" also describes every Claude Bash or
  Task run, the dominant queue case. Stamping there would repaint `Sending`,
  and D2's settle would then blank the indicator for the rest of the run.

The state that can genuinely come before a new turn is narrower, and that is
the one the gate stamps: the phase still says `awaiting-tool`, but no semantic
tool is pending. A Codex tool resolved through `tool_completed` produces it,
because the fold archives the turn while the phase machine only leaves
`awaiting-tool` on a matching `tool_result`. OpenCode never publishes
`awaiting-tool`.

*Accepted cost.* Any other non-idle phase that nothing returned to idle still
counts as live, for example `requesting` after an interrupted tool loop. A turn
that such a submit starts relabels the indicator on its first changed phase.
It keeps the stale phase's elapsed clock, though, because the phase machine
stamps `turnStartedAt` only while it is null; before #889 the stamp reset that
clock. Detecting staleness would need process-activity heuristics outside the
phase machine, and that is not done here.

### D2 — Settle a queue acceptance that did reach `submitting`

The renderer can believe a pane idle while Claude still queues (between turns
while Claude shows a spinner, during compaction, a stale phase). Then D1 does
stamp `submitting` and the acceptance comes back `queue`. A new streaming
action `settleQueuedSubmit(sessionId, stamp)` resets the five phase fields to
their idle values **only if** the runtime is still `submitting` **and** its
`submittedAt` is exactly the stamp this submit wrote. It does not touch
`awaitingAssistant` or `queuedMessages`. The queue-operation reducer owns those,
and its enqueue burst can land before or after the acceptance.

*Why a stamp token (review: Codex major / Claude F1).* The phase alone proves
that some submit stamped it, not which one. The recorded race:

1. Submit A on an idle pane stamps and resolves `user`.
2. The composer releases its in-flight guard before A's first provider event.
3. Submit B arrives in that gap, skips its stamp (D1), and Claude queues it.
4. A phase-only settle then reverted A's legitimate claim. The indicator went
   blank and A lost its submit-to-first-event clock. `turn_started` cannot
   repair that, because its bridge never leaves `idle`.

So `beginOptimisticSubmit` returns the exact `submittedAt` it wrote, or null
when it skipped:

- The decision is made inside the store updater. zustand `set` runs that
  updater synchronously, once, before returning, so the returned token is the
  committed decision.
- Issued stamps are clamped to strictly increase, so two can never compare
  equal.

`submittedAt` serves as the token instead of a new field for the same reason
as D1.

*Why not reuse `unwindOptimisticSubmit`:* unwind means "nothing reached the
provider" and clears `awaitingAssistant`. A queued prompt did reach the
provider; only the phase claim is false.

### D3 — Return the acceptance from `composerSubmit`

`RendererProviderCapabilities.composerSubmit` becomes
`(io) => Promise<PromptAcceptance | null>`. Claude and OpenCode return
`result.acceptance`; Codex, whose submit is raw PTY writes with no delivery
result, returns `null`. `submitCurrentDraft` calls `settleQueuedSubmit` with
its stamp token when `acceptance?.kind === 'queue'`. It also records the kind
on the `submit.result` lifecycle event, so the next incident is attributable
from the journal. Review round 1 closed the gaps in that promise:

- The strict Codex observation picker keeps an explicit `null`, which is the
  Codex composer's real answer. Its string vocabulary stays `user` / `queue` /
  `transport`.
- `scripts/summarize-lifecycle.mts` prints the key.
- Tests pin the key and the value that crosses the bridge.

### D4 — Strip collapse is a per-episode gesture

`QueueStrip` scopes `collapsed` to a queue episode. The count stays visible
while collapsed (existing behavior); a new episode always starts expanded.

*Episode boundary (review: Codex minor / Claude F8).* The first version reset
the collapse on an observed empty queue. That misses bursts:

- Main coalesces JSONL tail reads, and the Claude branch folds a whole burst in
  one runtime update.
- A drain plus a new enqueue in one burst therefore reaches the strip as
  `[A] → [B]`. The intermediate `[]` is never published.

So the boundary is membership. The collapse resets when no item of the
previous rendered queue survives into the next one. An empty queue shares
nothing, so the plain drain falls under the same rule. Growth (`[A] → [A, B]`)
and a partial drain (`[A, B] → [B]`) keep the collapse.

Identity is `(timestamp, content)`. That is the key the Claude reconciler's
enqueue idempotence guard and the strip's dialog selection already use, so no
identity was invented. The reset happens during render, using React's
previous-render pattern, so a new episode never paints a collapsed frame
first.

### D5 — Regression tests

- `streamingQueuedSubmit.renderer.test.tsx` (drives the real hook):
  - **D1 skips** over a live turn: signalled by the phase, by the semantic
    turn, or by a tool still running under an ended turn.
  - **D1 stamps** on an idle pane, and on a leftover `awaiting-tool` with
    nothing pending.
  - **Stamps are unique** within one millisecond.
  - **D2 settles only this submit's stamp.** Another submit's claim and a
    replaced claim both survive, and `turn_started` still advances the
    survivor.
- `useComposerKeybinds.queueAcceptance.renderer.test.tsx` (renderer, real
  workspace controller + real hook + fake feed + real `WorkIndicator`):
  - A queue acceptance with a draft image clears text and image, leaves
    `promptDelivery` idle, and journals `acceptance`.
  - Over a live turn the pane shows `Thinking`, never `Sending`.
  - An idle-pane queue settles with no `Sending`.
  - A `user` acceptance keeps `Sending`.
  - A queued second submit leaves the first submit's `Sending` and clock
    intact.

  This is the probe that ruled out the composer clear, promoted to a permanent
  contract.
- `QueueStrip.renderer.test.tsx`:
  - collapse, empty, refill → expanded;
  - a one-burst `[A] → [B]` → expanded;
  - growth and partial drain stay collapsed.
- `composerSubmit.test.ts` (opencode) asserts the returned acceptance.
- `src/shared/lifecycle/events.test.ts`:
  - `acceptance` survives `pickLifecycleData`, and the Codex `submit.result`
    projection, as both a string and null;
  - the string vocabulary stays closed.

## 3. Files

- `src/providers/registry.renderer.capabilities.ts` — capability type.
- `src/providers/claude/renderer/composerSubmit.ts`,
  `src/providers/opencode/renderer/composerSubmit.ts`,
  `src/providers/codex/renderer/composerSubmit.ts` — return values.
- `src/renderer/src/workspace/hook/actions/streaming.ts` — D1, D2.
- `src/renderer/src/workspace/hook/index.ts` — expose `settleQueuedSubmit`.
- `src/renderer/src/workspace/tile-tree/TileLeaf/useComposerKeybinds.ts` — D3.
- `src/renderer/src/workspace/tile-tree/TileLeaf/QueueStrip.tsx` — D4.
- `src/shared/lifecycle/events.ts` — `acceptance` key and Codex picker (D3).
- `scripts/summarize-lifecycle.mts` — prints `acceptance` (D3, review round 1).
- Tests per D5.

## 4. Verification

- `npx tsc -p tsconfig.node.json --pretty false && npx tsc -p tsconfig.web.json --pretty false`
- `NODE_ENV=test npx vitest run --project unit --project renderer` for the
  touched files, then the full `npm test` once before opening the PR.
- Node 24 (`nvm use 24`).

## 5. Out of scope, recorded

- Painting the queued prompt as a feed row while it is still pending. The
  strip owns pending prompts on purpose (see the QueueStrip header comment and
  the 2026-05-20 bundle); ownership transfers to the #665 durable row at the
  drain. Changing that is a rendering-ownership decision, not this fix.
- A toast on queue acceptance. The expanded strip plus a truthful indicator
  already say "queued"; a toast on ~23% of this user's submits is noise.
- Whatever put the text back into the composer in the two incidents. Not
  recoverable from the journals; revisit only if it recurs with the fixes in.

## 6. Result

Initial implementation (`089caf4c`, before the merge with `origin/main`) was
built as designed. Review round 1 then changed D1–D5; see §7.

- `beginOptimisticSubmit` skipped the phase stamp when `streamPhase !== 'idle'`
  or the semantic turn was running.
- `settleQueuedSubmit` reverted any stamped `submitting`.
- `composerSubmit` returns `PromptAcceptance | null`. The composer settles on
  `queue` and records `acceptance` on `submit.result`.
- The key was added to `SESSION_LIFECYCLE_DATA_KEYS`. It was also added to the
  Codex observation picker for forward compatibility. That picker line could
  not record anything: the Codex composer returns `null`, which the string
  picker dropped until review round 1.
- `QueueStrip` reset `collapsed` when an empty queue rendered.
- Tests written first and confirmed red (10 new assertions failing, 10
  pre-existing passing), then green: `streamingQueuedSubmit.renderer.test.tsx`,
  `useComposerKeybinds.queueAcceptance.renderer.test.tsx`,
  `QueueStrip.renderer.test.tsx` (+1), `opencode/composerSubmit.test.ts` (+1).
- `npm run typecheck` clean (control-sdk, workflow-mcp build, `tsc -b`); raw
  `tsc -p tsconfig.node.json` and `tsc -p tsconfig.web.json` clean.
- Full `npm test`: 463 files / 3185 tests passed; 6 failures in
  `app-state/store.test.ts` (4 × "timed out in 5000ms") and
  `media/imageAttachment.test.ts` (1 × census cites a Claude session file
  deleted from this machine) are the known local-environment failures that
  also fail on `origin/main`; CI is the gate for those.
- The `npm run typecheck`, `tsc` and full `npm test` numbers above were
  measured on `089caf4c`. The merged head `fa4f2faa` (`origin/main` `115e26fc`
  merged in) is verified by CI: `quality-gate` and `minimum-node-fixture-gate`
  both passed.

## 7. Review round 1 (2026-09-12)

Two independent reviews of head `fa4f2faa`:

- **Codex:** REQUEST CHANGES — 1 major, 1 minor, 1 nit.
- **Claude:** APPROVE WITH COMMENTS — F1–F9.

Every finding was checked against source before anything was changed.

| Finding | Disposition |
|---|---|
| Codex major = Claude F1: the queue settle reverts an earlier submit's `submitting` | Fixed in `54a44e37`: stamp ownership token (D2). |
| Claude F2: the gate applies to every provider, but its WHY argued Claude only | Fixed in `1076bf89`, deliberately not with the suggested rule. "`awaiting-tool` without a running turn" is also every Claude tool run, so the gate splits on pending tools (D1). |
| Claude F3: tests stop short of the visible text | Fixed in `897fa8ff`: the real `WorkIndicator` is rendered and asserted. |
| Claude F4: `acceptance` has no test and the summarizer never prints it | Fixed in `93da9d7c`. |
| Codex nit: the Codex picker drops an explicit `null` acceptance | Fixed in `93da9d7c`: `null` is kept, strings stay closed. |
| Claude F5: the Codex picker line is dead code, and "needed" overclaims | The code is resolved by the Codex nit fix: the line now records Codex's `null`, and the string branch stays for forward compatibility. Wording fixed in §6 and the PR body. |
| Claude F6: stale comments say the stamp is unconditional | Fixed in `1076bf89`. |
| Claude F7: verification predates the merge, and the OpenCode limitation is overstated | Fixed in §6 and the PR body. |
| Codex minor = Claude F8: a drain + refill inside one burst keeps the strip collapsed | Fixed in `33b6d511`: membership episode boundary (D4). Growth within the same episode keeps the collapse by design. |
| Claude F9: commit footers use `Fixes` instead of `Refs` | No change, as the reviewer suggested. Review-round commits use `Refs`. |

Mutation checks. Each production rule was temporarily reverted, and the
change was restored byte-for-byte afterwards.

- **Settle ownership.** Back to the phase-only guard: 3 tests fail. Two are in
  the hook suite (another submit's claim; a replaced claim) and one is the
  controller two-submit test.
- **Gate, `awaiting-tool` always live** (the pre-review rule): only "stamps
  Sending on an awaiting-tool phase that outlived its tool" fails.
- **Gate, `awaiting-tool` never live** (the review's literal rule): only "does
  not stamp Sending while a tool is still running under an ended turn" fails.
- **Episode rule, reset only on an empty queue** (the pre-review rule): only
  the one-burst `[A] → [B]` test fails.
- **Episode rule, reset whenever any unseen item appears:** only the
  same-episode growth/partial-drain test fails.

Verification of the round on `897fa8ff` (Node 24.14.1). The plan commit that
follows changes no code.

- **tsc:** raw `tsc -p tsconfig.node.json` then `tsc -p tsconfig.web.json` were
  both clean (exit 0, no diagnostics).
- **Touched test files:**
  - renderer: 3 files / 26 tests passed (`streamingQueuedSubmit`,
    `useComposerKeybinds.queueAcceptance`, `QueueStrip`);
  - unit: 2 files / 15 tests passed (`events.test.ts`,
    `opencode/composerSubmit.test.ts`).
- **`vitest related --run`** on `streaming.ts`, `useComposerKeybinds.ts`,
  `QueueStrip.tsx` and `events.ts`: 70 files / 599 tests passed.
- The full suite was not re-run this round.
