# Queued Prompt Visibility Implementation Plan

> Status: in progress on `fix/queued-prompt-visibility`. Fixes #889 and #890.

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

### D1 — Do not stamp the optimistic phase over a live turn

`beginOptimisticSubmit` is the only writer of the optimistic `submitting`
phase. When the pane already has a live turn (`isSemanticTurnRunning(
current.semantic.currentTurn)` or `current.streamPhase !== 'idle'`), the
submit will be queued by Claude; painting `Sending` there is a lie from the
first frame. In that branch the action still clears `pendingRewindUndo` and
appends the `submit started` feed-debug row (with a `queued-behind-live-turn`
note), but leaves `streamPhase`, `turnStartedAt`, `phaseChangedAt`,
`submittedAt` and `awaitingAssistant` untouched. The indicator keeps showing
the running turn's real phase and its real elapsed time.

*Why not restore the prior phase after the fact:* restoring needs the prior
five fields stashed somewhere; a new `SessionRuntime` field for that would ride
into every debug bundle and every runtime spread for a value the UI never
reads. Not painting the lie is simpler than repainting the truth.

### D2 — Settle a queue acceptance that did reach `submitting`

The renderer can believe a pane idle while Claude still queues (between turns
while Claude shows a spinner, during compaction, a stale phase). Then D1 does
stamp `submitting` and the acceptance comes back `queue`. A new streaming
action `settleQueuedSubmit(sessionId)` resets the five phase fields to their
idle values **only if** `streamPhase === 'submitting'`. It does not touch
`awaitingAssistant` or `queuedMessages` — the queue-operation reducer owns
those and its enqueue burst can land before or after the acceptance.

*Why not reuse `unwindOptimisticSubmit`:* unwind means "nothing reached the
provider" and clears `awaitingAssistant`. A queued prompt did reach the
provider; only the phase claim is false.

### D3 — Return the acceptance from `composerSubmit`

`RendererProviderCapabilities.composerSubmit` becomes
`(io) => Promise<PromptAcceptance | null>`. Claude and OpenCode return
`result.acceptance`; Codex, whose submit is raw PTY writes with no delivery
result, returns `null`. `submitCurrentDraft` calls `settleQueuedSubmit` when
`acceptance?.kind === 'queue'` and records the kind on the `submit.result`
lifecycle event so the next incident is attributable from the journal.

### D4 — Strip collapse is a per-episode gesture

`QueueStrip` resets `collapsed` to `false` whenever the queue empties. The
count stays visible while collapsed (existing behavior); a new episode always
starts expanded.

### D5 — Regression tests

- `streaming.actions.test.ts` (unit): D1 preserves phase fields over a live
  turn and still stamps them on an idle pane; D2 resets only `submitting`.
- `useComposerKeybinds.queueAcceptance.renderer.test.tsx` (renderer, real
  workspace controller + real hook + fake feed): queue acceptance with a draft
  image clears text and image, leaves `promptDelivery` idle, and leaves the
  pane on the live turn's phase; user acceptance is unchanged. This is the
  probe that ruled out the composer clear, promoted to a permanent contract.
- `QueueStrip.renderer.test.tsx`: collapse, empty, refill → expanded.
- `composerSubmit.test.ts` (opencode) asserts the returned acceptance.

## 3. Files

- `src/providers/registry.renderer.capabilities.ts` — capability type.
- `src/providers/claude/renderer/composerSubmit.ts`,
  `src/providers/opencode/renderer/composerSubmit.ts`,
  `src/providers/codex/renderer/composerSubmit.ts` — return values.
- `src/renderer/src/workspace/hook/actions/streaming.ts` — D1, D2.
- `src/renderer/src/workspace/hook/index.ts` — expose `settleQueuedSubmit`.
- `src/renderer/src/workspace/tile-tree/TileLeaf/useComposerKeybinds.ts` — D3.
- `src/renderer/src/workspace/tile-tree/TileLeaf/QueueStrip.tsx` — D4.
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
