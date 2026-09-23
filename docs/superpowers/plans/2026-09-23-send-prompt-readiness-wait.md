# send_prompt waits for a child that is not ready YET — Implementation Plan

**Goal:** Ship issue #1134. `orchestration_send_prompt` gets the same "not ready
yet" wait that `orchestration_create_agent` got in #854 (`493bf92c`): a prompt
sent to a child whose composer is warming or blocked by a trust dialog waits
for the composer and the reply says it is pending, instead of failing with
`disposition: retry-same-session` and inviting the immediate retry that can
orphan a half-written draft.

**Evidence:** incident journals 2026-08-30 → 2026-09-22 hold 124
`orchestration.prompt_delivery_failed` incidents; 97 are `before-write /
not-ready`; the largest single group is 36 `send_prompt / before-write /
not-ready / retry-same-session`. Every run in that set predates #854, so the
effect of this change cannot be measured from the existing journals.

**Working tree:** `.worktrees/send-prompt-readiness-wait`, branch
`fix/send-prompt-readiness-wait`, based on `origin/main` (`d9c131bb`).

---

## Design

### Where the wait lives

Reuse the #854 machinery unchanged in spirit:

- `isNotReadyYet(delivery)` decides the failure is "early", not "failed".
- `SessionManager.canWaitForPromptReadiness(sessionId)` is asked BEFORE the
  reply promises anything — OpenCode and Grok have no readiness gate, so they
  keep today's failure reply (the #854 review note).
- `SessionManager.deliverPromptWhenReady(sessionId, prompt)` holds the prompt.

The create_agent pending branch (arm the waiter, bookkeeping on landing,
incident on a later failure, pending reply) is factored into one module-level
helper in `createBuiltInMcpServer.ts` that both tools call. create_agent's
observable behaviour must not change: same reply fields, same incident reason
(`create_agent_bootstrap_pending`), bootstrap always marked on landing.

### Bootstrap wrapping

send_prompt wraps the prompt in the orchestration handoff when
`orchestrationBootstrapPromptDelivered !== true` and marks it delivered after a
direct success. On the pending path the mark happens ONLY in the landing
callback, and only when this call wrapped (`shouldWrap`) — a follow-up to an
already-bootstrapped child must not re-mark anything.

### One waiting orchestration prompt per session, latest wins

Semantics (the invariant that prevents duplicates):

1. At most ONE orchestration prompt waits per session (already enforced by the
   `pendingPromptDeliveries` map).
2. A newer orchestration prompt REPLACES a waiting one — whether the waiting
   one is a create_agent brief or an earlier send_prompt. This is the rule
   #854 already established for a hand-sent brief (`supersedesPendingPrompt`
   on the direct attempt); send_prompt now also passes it when ARMING its own
   waiter, so a superseded waiter that has not finished unwinding yet cannot
   make the new waiter get refused as "a prompt is already waiting" (which
   would turn a promised `promptPending` into a silent loss).
3. A superseded waiter never writes: cancellation is checked synchronously
   between the gate answering `ready` and the delivery starting, and a waiter
   that has already started delivering is no longer in the map (it is then
   protected by the in-flight reservation, and the new send fails loudly with
   `delivery-in-flight` instead of duplicating).
4. The reply says so: `supersededPendingPrompt: true` when this send replaced
   a waiting prompt, so a parent that sent a DIFFERENT follow-up learns the
   earlier one will not arrive. Detected via the existing `record` hook
   (`pending-superseded`) that `deliverPromptToAgent` already threads, rather
   than a new manager API.

Rejected alternatives:

- **Refuse a second send while one is pending.** No duplicate, but the parent
  cannot correct or replace a brief stuck behind a trust dialog without closing
  the child, and it contradicts the existing create_agent → send_prompt
  supersede rule.
- **Queue both.** Ordering questions (#854's own scope note) and two tasks
  arriving back-to-back in a child that was told nothing about the first.

### Journal

A pending delivery that later fails is recorded as
`orchestration.prompt_delivery_failed` with `reason: send_prompt_pending`,
same context fields as create_agent's `create_agent_bootstrap_pending`.

## Tasks

- [x] Plan (this file) — first commit.
- [x] `SessionManager.deliverPromptWhenReady` gains
      `options.supersedesPendingPrompt`; `deliverPromptToAgent` records
      `pending-superseded` when its supersede actually cancelled a waiter.
- [x] Factor the create_agent pending branch into a shared helper.
- [x] send_prompt uses the helper; pending reply; bootstrap mark on landing;
      `send_prompt_pending` incident; `supersededPendingPrompt` in replies.
- [x] Tests (MCP-level with the faked manager, mirroring
      `orchestrationBootstrapPending.system.test.ts`; plus a real
      `SessionManager` driven through the MCP tool for the no-duplicate cases;
      plus the manager-level supersede-on-arm case):
  - not-ready child → `promptPending: true`, delivered later, bootstrap marked
    only on landing;
  - earlier pending create_agent brief + send_prompt → only the send_prompt
    text is ever written;
  - second send_prompt while the first is pending → only the second is
    written;
  - OpenCode/Grok (no gate) → today's failure reply, no waiter;
  - later failure → `send_prompt_pending` incident.
- [x] Verify once: `npx tsc -b` + targeted vitest (Node 24).
- [x] Tool description of `orchestration_send_prompt` states the pending
      contract and "a newer prompt replaces a waiting one".
- [x] PR (do not merge).

## Verification notes

- The 7 new MCP-level cases and 2 manager cases fail with the source changes
  stashed (origin/main behaviour); the no-gate and absorption cases are
  controls and pass on both.
- The real-SessionManager duplicate tests do NOT reproduce the "cancelled
  waiter has not unwound yet" race end to end: in practice the old waiter
  unwinds in fewer microtasks than the direct attempt takes. That race is
  pinned at the manager level instead (`deliverPromptWhenReady` with
  `supersedesPendingPrompt` after a cancel with no timer run in between), and
  the MCP level asserts the flag reaches the arm.

## Review round (two reviewers)

- **"Reservation refusal is armed as pending" (HIGH) — not reproduced.**
  `delivery-in-flight` carries `stage: 'reservation'`, and `isNotReadyYet`
  rejects every stage but `before-write`, so it was already a failure reply
  (reviewer B confirmed this). Kept as-is, the comments now name the
  reservation case, and a real-SessionManager MCP test pins it: a waiter
  mid-delivery plus send_prompt gives `ok:false delivery-in-flight` and
  exactly one write. The test passes on the pre-review commit and fails when
  the stage check is mutated to let `reservation` through.
- [x] Arm-time supersede is reported: `deliverPromptWhenReady` emits
      `pending-superseded` synchronously when it cancels a live waiter, and
      send_prompt ORs it into `supersededPendingPrompt`.
- [x] Pending state is visible to `wait_agents`: `bridge.notePromptPending`
      on arm (token-scoped), `notePromptPendingSettled` on landing or failure,
      and `lifecycleWithPromptDelivery` reports `prompt_sent` while pending
      (any state but `closed`). This applies to create_agent too, where the
      child already read as active (`created`/`waiting` → `prompt_sent`).
- [x] Tool description and pending message: waiting only for providers that
      support it; "busy with a turn" is a not-ready state and the prompt lands
      after the current turn.
