# Goal Loop Turn Boundary: Plan

**Issue:** #1024 (bug). **Branch:** `fix/goal-loop-turn-boundary` from `origin/main` @ `52af3dfd`.
Release-readiness ledger thread T15.

## Problem (root-caused from recordings, see the #1024 comment)

A goal loop in a Claude session delivered 37 continuations **mid-turn**. Every one
arrived as a `queued_command` attachment, and they came in bursts: 31 in 17 minutes,
with pairs 0.4 s apart.

`GoalLoopService` treats a semantic working→idle edge as "the turn ended". For
Claude, phase `idle` only means "no main API request is streaming", and inside one
turn that is true at every local tool gap. The edge that fired came from a Task
subagent's API flow, 860 of this session's 1,085 requests:
1. the flow took phase ownership on its first chunk during a tool gap and
   published `requesting`;
2. at `message_start` the `cc_is_subagent` routing demoted it again, publishing
   `idle` and `flow_ignored`;
3. the goal loop delivered.

#1008's one-macrotask deferral cannot catch this, because nothing retracts the
edge.

## Principle

A loop continuation belongs at a **turn** boundary, and a stream phase is not one.
Claude and Codex both expose an authoritative turn boundary: the provider's `Stop`
hook. It fires only when the MAIN agent ends its turn; subagents have
`SubagentStop`. Agent Code already receives it per session registration at
`/hooks/tldr/stop`, for TLDR enforcement.

## Changes

1. **Hook installation** (`BuiltInMcpHttpHost.registerSession`): install the turn
   hooks when the `goal_loop` domain is on, not only for tldr or goal.
2. **Hook → loop signal** (`BuiltInMcpHttpHost.handleTldrHook`): on every turn hook,
   tell the loop what happened (`user-prompt-submit`, `post-tool-use`, or `stop`),
   and whether the Stop was blocked by TLDR enforcement. TLDR enforcement still
   runs only for sessions with a reporting domain.
3. **Loop boundary** (`GoalLoopService`):
   - The first hook seen for a session proves its hooks work. `goal_loop_start` is a
     tool call, so `post-tool-use` fires before the turn that started the loop
     ends. From then on the session is **hook-driven**:
     - stream-phase idle edges no longer trigger continuations;
     - an **allowed** `Stop` is the only turn boundary;
     - a Stop that TLDR enforcement blocked is not a boundary, because the turn
       continues.
   - A hook-driven session tracks `turnOpen`: set on `user-prompt-submit` and
     `post-tool-use`, and on the loop's own delivery; cleared on an allowed Stop.
     Resume and backoff triggers deliver only when no turn is open, instead of
     trusting the phase-derived working state.
   - The delivery is deferred one macrotask, so the Stop hook's HTTP response goes
     out first.
   - Sessions whose provider never calls hooks (OpenCode, Grok) keep the phase
     fallback, unchanged.

## Tests (fail-first)

In `GoalLoopService.test.ts`, the phase sequence around each delivery is the one
recorded in the session's feed log (`flow_selected` → `stream_phase` →
`flow_ignored`). The phase values come from the Claude adapter's own code path
(`requesting` on first-chunk promotion, `idle` on subagent demotion).

- A hook-driven session: that sequence during a tool gap delivers nothing. An
  allowed Stop then delivers exactly one continuation.
- A blocked Stop followed by an allowed Stop delivers one continuation, not two.
- Resume during an open hook turn waits for the Stop.
- A session without hooks keeps the phase fallback.

The host tests cover the hook notification, and hook installation for a
`goal_loop`-only registration.

## Out of scope (follow-up)

The Claude proxy adapter should also route `cc_is_subagent` flows as secondary
**before** first-chunk promotion, since the flag is known at request time. That
removes the phase flap at its source, which also fixes spinner flicker and
working-time accounting. It lives in the claude-code-headless package, so it is a
separate PR. A sanitized recorded fixture for it already exists in that package's
worktree.
