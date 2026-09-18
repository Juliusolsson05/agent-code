# Goal Loop — Feature Design

Status: Approved design, pending implementation
Date: 2026-09-18
Branch: `feat/agent-goal-loop`

## Motivation

Agents stop too early. A model asked to work toward a goal will end its turn at the
first natural pause — leaving multi-hour, multi-step objectives half-finished until a
human notices and re-prompts. Agent Code owns the send interface
(`SessionManager.deliverPromptToAgent`) and observes every turn boundary
(`turn_completed` semantic events), so it — not the model, not the provider — is the
right party to keep an agent working until a goal is genuinely complete.

The feature: the user tells an agent to "run a loop on X". The **agent** calls an MCP
tool that starts a harness-owned loop, writing the continuation prompt itself. From
then on, whenever the session goes idle without the loop being finished, Agent Code
re-sends the continuation prompt. The loop breaks only when the agent calls
`goal_loop_complete` — instructed to do so *only* when the goal is utterly satisfied —
or when the user intervenes, or when a safety cap pauses it. A control modal gives the
user live visibility and one-key control.

## Prior art and why we are not using provider hooks

- **Claude Code Stop hooks** return `{decision: "block", reason}` to force one more
  step, but Claude Code **force-stops after 9 consecutive Stop-hook blocks**. Every
  community "persistence mode" built on this mechanism (ralph, ultrawork, autopilot,
  ultragoal — oh-my-claudecode #3138) is killed by that override. A goal loop that
  dies after 9 continuations is not a goal loop.
- Our own TLDR/Goal enforcement (`src/main/tldr/enforcement.ts`) *deliberately*
  guarantees at most one block per turn by honoring `stop_hook_active`. A sustained
  loop would have to violate the contract we just shipped.
- Hook-blocking keeps the whole loop inside one provider turn: no turn boundaries for
  compaction seams, and our working-state/usage/queue machinery assumes turns end.
- OpenCode has no block-capable Stop hook at all, so a hook path could never be
  universal across our three providers.
- **Ralph Wiggum** (official `anthropics/claude-code` plugin, `/ralph-loop` with
  `--completion-promise` and `--max-iterations 50`) validates the product shape:
  persistence + explicit completion signal + iteration cap. Our advantages over it:
  the completion signal is a real MCP tool call instead of a magic
  `<promise>DONE</promise>` output string (no parsing, no "did it lie" ambiguity),
  and the loop driver is the harness (unbounded by provider overrides, provider-
  agnostic) rather than a Stop hook.

Decision: **single mechanism — harness-owned loop.** Stop hooks remain exclusively
for the existing TLDR/Goal nudges, untouched.

## MCP surface

New built-in domain `goal_loop`, registered exactly like the existing `goal` domain
(scope authority = the authenticated session identity, never a model-supplied id).

| Tool | Schema | Model instructions |
|---|---|---|
| `goal_loop_start` | `goal: string`, `loopPrompt: string` (both required) | Call when the user asks to start a loop. `loopPrompt` drives every iteration — write it self-contained ("keep working toward <goal>: reassess remaining work, continue where you left off"), because it is all you see on each wake-up. |
| `goal_loop_complete` | `outcome: 'done' \| 'blocked'`, `summary: string` | Call **only** when the goal is completely and utterly satisfied and verified — never to exit early. `blocked` is the honest exit when you need the user (missing input, impossible constraint). |

- One active loop per session.
- Domain off by default, user-configurable on (Settings registry row, same as Goal and every
  sibling capability — the earlier "default-on" wording here contradicted the Settings
  convention every other domain follows; corrected during PR review).
- Domain unions to touch: `src/mcp/shared/types.ts` (`BuiltInMcpDomain`,
  `BUILT_IN_MCP_DOMAINS`, `CONFIGURABLE_BUILT_IN_MCP_DOMAINS`,
  `BUILT_IN_MCP_DOMAINS_BY_PROVIDER`).

## Architecture

Main-process ownership, because the loop must observe `turn_completed` events and
call `deliverPromptToAgent` — both live in main — and must survive pane visibility.

Rejected placements:
- *Renderer-owned* (orchestration precedent): orchestration answers MCP calls in the
  renderer because workspace ownership lives there; but a loop that dies when a pane
  hides and needs a main round-trip per continuation is strictly worse here.
- *Workflow-engine-based*: durable with free retries, but workflows run headless
  provider threads, not the user's live interactive pane; we would lose steering and
  the send interface we specifically own.

Components:

```
src/mcp/shared/types.ts                    add 'goal_loop' domain + allowlists
src/mcp/runtime/createBuiltInMcpServer.ts  goal_loop_start / goal_loop_complete (goal_set pattern)
src/mcp/shared/goalLoopPrompt.ts           continuation prompt builder (mirrors orchestrationPrompt.ts)
src/main/goalLoop/GoalLoopService.ts       state machine + semantic-event subscription + delivery
src/main/goalLoop/GoalLoopStore.ts         durable JSON state (atomic writer, mirrors TldrStore)
src/main/goalLoop/ipc.ts                   status queries + pause/resume/stop/raise-cap commands
src/renderer/src/features/goal-loop/       control modal, palette commands, keybinding, viewState
```

Continuation prompt = harness header (iteration N of cap, the goal, the
"call `goal_loop_complete` only when utterly done — otherwise keep working"
contract) + the agent-written `loopPrompt`.

## Loop state machine

```
idle ──goal_loop_start──▶ active ──goal_loop_complete──▶ ended(done|blocked)
                           │ ▲
        turn_completed, no complete, iter < cap ─────────┘ (deliver continuation)
                           ├── iter ≥ cap ───────▶ paused(cap)      (modal: resume/raise/stop)
                           ├── delivery error ×3 ▶ paused(error)
                           ├── user pause/stop ──▶ paused(user) | ended(cancelled)
                           └── app restart ──────▶ paused(interrupted)
```

Guards:
- Idle detection reuses `reduceWorkingState` (never continues while tools are
  pending, i.e. `awaiting-tool`).
- A user-typed prompt during an active loop is **steering, not a break**: it flows
  through the normal queue; the loop does not deliver a continuation for a turn the
  user started, and resumes after that turn settles.
- Double-delivery is prevented by the existing `promptDeliveriesInFlight` mutual
  exclusion inside `deliverPromptToAgent`.
- Parked/hidden agents are woken through the existing `ensure-agent-live`
  renderer round-trip (same path as `orchestration_send_prompt`).
- Provider switch/reload mid-loop → `paused(interrupted)`; resume is a single modal
  action that delivers one fresh continuation. Conservative v1.

## Safety

- Iteration cap **default 25** continuations (Ralph uses 50; our continuation prompts
  are richer so convergence should come sooner), configurable per loop at start.
  Reaching the cap **pauses with the modal** offering resume / raise cap / stop.
  Never a silent hard kill, never uncapped.
- `paused(error)` after 3 consecutive failed deliveries (respecting
  `PromptDeliveryResult.retrySafe` dispositions — one immediate retry for
  retry-safe failures before counting).
- Every state change is journaled to `GoalLoopStore`, so after a crash the modal
  reports `paused(interrupted)` truthfully and the user decides what to do.

## Control modal (user surface)

A first-class **control** surface, not just a peek:

- `PreviewKind = 'tldr' | 'goal' | 'goal-loop'` in the existing tldr viewState
  store; hold-peek and overlay show: goal, iteration N / cap, state, last
  continuation at, and completion history (`done`/`blocked` summaries).
- Modal actions: **pause, resume, raise cap, stop**.
- Command palette: `goal-loop-preview`, `goal-loop-stop`.
- Keybinding: `Cmd+Shift+G` (subject to `npm run check:keybindings` conflict
  validation).
- Settings row for the domain in `settingsRegistry.ts`, off by default like its siblings.

## Testing

- **Unit** — `GoalLoopService` state machine against synthetic semantic-event
  streams (template: agentActivity tests): idle→continue, cap→pause,
  complete→end, steering coexistence, restart→interrupted, error backoff.
- **System** — `TldrStore.system.test.ts` pattern: real `BuiltInMcpHttpHost` +
  `createBuiltInMcpServer`; call `goal_loop_start` over MCP, emit
  `turn_completed`, assert `deliverPromptToAgent` received the exact continuation
  prompt; assert cross-session tool calls are rejected.
- **Renderer** — viewState + palette command wiring smoke tests.

## Chosen defaults (revisable)

Cap 25 pause-at-cap; one loop per session; `blocked` outcome on complete; loops
pause on provider switch; domain off by default like its siblings; continuation prompt written once at
`goal_loop_start` and reused verbatim every iteration (with only the harness header
changing).
