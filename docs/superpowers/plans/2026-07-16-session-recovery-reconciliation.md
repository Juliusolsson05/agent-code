# Session Recovery and Renderer Reconciliation — Implementation Plan

**Status:** Reviewed and ready for implementation

**Date:** 2026-07-16

**Branch:** `fix/session-recovery-reconciliation`

**Worktree:** `/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/session-recovery-reconciliation`

## Goal

Make workspace restoration deterministic across both kinds of restart:

1. A **renderer reload** re-adopts the provider processes that the main process
   still owns. It does not create duplicate Claude, Codex, opencode, proxy, or
   Workflow MCP state.
2. A **full application restart** recreates each visible backend exactly once,
   under its persisted Agent Code `SessionId`, and asks the provider to resume
   the persisted durable conversation.
3. A failed or not-yet-composer-ready backend remains visible and honest. Its
   pane, layout, draft, and retry action survive.
4. Closing a pane while recovery is in flight cannot leave an orphan provider
   process behind.

Keep the existing `SessionManager` name and overall shape. The missing
abstraction is one atomic main-owned recovery operation, not a new service
layer, framework, or cosmetic rename.

## Why this plan exists

Session ownership is split across three ledgers:

- `SessionManager` owns the live backend process under a local `SessionId`.
- The renderer workspace owns durable pane/layout metadata under that same
  local `SessionId`.
- Each provider owns a separate durable history identity, such as Claude's
  session id or Codex's thread id.

The local id and provider id are not interchangeable. Clones, rewinds, and
provider-approved forks may intentionally share or replace provider history
identity. The persisted local `SessionId` is therefore the only safe key for
deciding whether a renderer pane may adopt a live main-process backend.

Today `ensureSessionLive()` partially follows that rule, but
`rehydrateWorkspace()` bypasses it and calls `spawnSession()` directly. That
path allocates a new local id, remaps the workspace, and cannot tell whether
main already owns the old id. A renderer-only reload can therefore create a
second provider process, proxy, and set of session-scoped MCP credentials while
the first process remains alive.

The readiness signal is also optimistic. `session:started` and generic
process-state events currently set renderer `inputReady: true`. Claude can
still be consuming its bootstrap transcript during that interval. The
orchestration consultation reproduced the failure: create-and-prompt could be
rejected because transcript replay had not quiesced, while create-then-wait-
then-prompt succeeded.

## Confirmed current seams

This plan is based on the 2026-07-16 `origin/main` baseline at `057f7eb7`.

- `src/main/sessionManager.ts`
  - owns live local-id registration;
  - accepts `preferredSessionId` on `spawn()`;
  - reserves `spawningSessionIds` before provider startup;
  - caches screen, condition, transcript-path, cwd, and activity facts;
  - registers the session entry before `session.start()` resolves.
- `src/renderer/src/workspace/hook/actions/session.ts`
  - `ensureSessionLive()` performs a renderer-side check-then-spawn;
  - it has a local UI single-flight, but that cannot serialize rehydrate,
    another renderer, and direct main callers.
- `src/renderer/src/workspace/hook/persistence/rehydrate.ts`
  - directly calls `spawnSession()` for visible persisted leaves;
  - allocates new local ids and builds an old-to-new `idMap`;
  - removes a visible leaf when spawn throws because `spawnedIds` is the
    sanitization source of truth.
- `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts`
  - grants readiness from `session:started` and `session:process-state`;
  - cannot recover an edge event that fired before renderer reload.
- `src/providers/claude/runtime/claudeSession.ts`
  - already has the real transcript-replay quiet gate in
    `readyForLiveBridge` / `isPromptAcceptanceReady()`;
  - the timer transition that arms it currently emits no generic readiness.
- `src/providers/codex/runtime/codexSession.ts`
  - has a provider-specific composer predicate in `awaitReadyForPrompt()`;
  - it is currently a per-delivery poll rather than a recoverable level fact.
- `src/providers/opencode/runtime/opencodeSession.ts`
  - `headless.start()` owns bootstrap replay and server readiness.
- `src/shared/sessionFeed/`
  - is the existing transport abstraction that both local IPC and the remote
    WebSocket client must use; readiness must not bypass it through raw
    `window.api` subscriptions.

## Core invariants

1. **The persisted local `SessionId` is the ownership key.** Recovery never
   searches or adopts by `providerSessionId`.
2. **Recovery is atomic in main.** No renderer performs a separate live check
   followed by spawn.
3. **The recovery claim is reserved synchronously.** It is installed before
   any await, provider construction, MCP registration, or other re-entrant
   work.
4. **At most one startup owns a local id.** Concurrent compatible recoveries
   join one in-flight claim; incompatible requests return a typed conflict.
5. **Adoption is side-effect free.** It does not mint MCP tokens, start a
   proxy, restart a provider, or replay history.
6. **Cold recovery preserves the local id.** Layout relationships never
   receive a new routing id merely because the app restarted.
7. **Provider history identity is a launch hint, not ownership.** It is used
   only when a missing backend must be spawned/resumed.
8. **Composer readiness is level-triggered and versioned.** A late renderer
   gets the current fact, and a stale seed cannot overwrite a newer event.
9. **Failure preserves user state.** Backend failure never deletes a tile,
   draft, pin, dispatch relationship, or persisted metadata.
10. **Restore completion is not equivalent to startup success.** Autosave may
    resume after every visible leaf has a resolved outcome: adopted, spawned,
    or retained as failed.
11. **Kill wins over in-flight recovery.** A pane closed during startup cannot
    be resurrected or leak its provider after startup resolves.
12. **No silent prompt loss.** Finished-prompt delivery rejects a missing or
    not-composer-ready backend without clearing the draft or claiming success.
    Raw provider/condition keystrokes reject a missing/exited backend, but are
    not blanket-blocked by composer readiness because they may be required to
    answer trust or permission prompts.
13. **Tests use deterministic fake providers.** No paid API calls, arbitrary
    sleeps, real provider binaries, or packaged Electron app are required for
    the regression suite.

## Explicit non-goals

- Do not rename `SessionManager` to `SessionService`.
- Do not move `sessionManager.ts` in this PR. `src/main/sessions/` already
  exists, and a case-only/mechanical move is unrelated to correctness.
- Do not add a state-machine dependency or a durable main-process session DB.
- Do not move provider-specific resume semantics into main.
- Do not unify raw PTY bytes and finished-prompt delivery behind a vague
  `sendInput()` method.
- Do not kill all live providers during renderer reload and then respawn them.
- Do not add `listBackendSnapshots()` without a real consumer.
- Do not invent Codex lineage/rebase proof in this PR. Provider resume identity
  acceptance is a separate follow-up described below.
- Do not combine this work with feed rendering, workflow UI, or unrelated
  directory cleanup.

## Target contract

### Shared types

Define readiness once in `src/shared/types/session.ts` and re-export it where
preload contracts need it. Do not keep duplicate `AgentInputReadiness` and
`SessionInputReadiness` shapes.

```ts
export type SessionInputReadiness = {
  ready: boolean
  revision: number
  reason?: 'starting' | 'replaying-history' | 'provider-not-ready' | 'ready'
}

export type SessionBackendSnapshot = {
  sessionId: string
  kind: SessionKind
  cwd: string
  lifecycle: 'spawning' | 'live'
  input: SessionInputReadiness
}

export type SessionRecoverOptions = Omit<SessionSpawnOptions, 'preferredSessionId'> & {
  sessionId: string
}

export type SessionRecoverResult =
  | {
      ok: true
      disposition: 'adopted' | 'spawned'
      snapshot: SessionBackendSnapshot
      tmuxName?: string
    }
  | {
      ok: false
      code: 'ownership-conflict' | 'cancelled' | 'start-failed'
      retryable: boolean
      message: string
      actual?: Pick<SessionBackendSnapshot, 'kind' | 'cwd' | 'lifecycle'>
    }
```

`reason` is diagnostic/advisory; correctness gates only on `ready` and
`revision`. The snapshot deliberately omits a supposed current provider id.
Main owns a spawn-time resume hint, not the durable provider identity verdict.

### `SessionManager` surface

```ts
SessionManager.recover(options: SessionRecoverOptions): Promise<SessionRecoverResult>
SessionManager.spawn(options: SessionSpawnOptions): Promise<SessionSpawnResult>
SessionManager.kill(sessionId: string): Promise<boolean>
SessionManager.getBackendSnapshot(sessionId: string): SessionBackendSnapshot | null
SessionManager.write(sessionId: string, data: string): boolean
SessionManager.deliverPromptToAgent(...): Promise<PromptDeliveryResult>
```

`spawn()` creates a genuinely new pane. After the caller census in Slice 1,
`recover()` is the sole public path allowed to request a persisted local id.
Remove `preferredSessionId` from renderer-facing spawn options; keep any
required implementation detail private inside `SessionManager`.

### Conflict rules

- Kind is a hard ownership check.
- Compare cwd using one lexical normalization function based on
  `path.resolve()`. Do not use `realpath`: recovery must also work when a cwd is
  temporarily unavailable, and resolving symlinks would add asynchronous I/O
  to the atomic claim boundary.
- A normalized cwd mismatch is a typed conflict. Adopting a live backend rooted
  in another project could attach the wrong project-scoped MCP authority, so a
  warning-only mismatch is unsafe.
- Resume id and MCP domains are not compared during adoption. They are launch
  inputs. If no backend exists, normal cold spawn consumes the persisted inputs
  and mints one fresh ephemeral MCP credential set.

### Atomic recovery algorithm

`recover()` must reserve a claim synchronously before it can call provider or
MCP code:

1. Normalize the request and inspect `recoveriesInFlight`.
   - Compatible claim: join it.
   - Different kind/cwd: return `ownership-conflict`.
2. Inspect the live registry.
   - Matching entry: return `adopted` with its current snapshot.
   - Mismatch: return `ownership-conflict` without replacing it.
3. Install a `RecoveryClaim` in `recoveriesInFlight` **before** starting work.
   The claim contains the normalized ownership request, shared promise, and a
   cancellation flag.
4. Start through a private stable-id spawn path. Extend `spawnInfo` to retain
   kind as well as cwd/resume data so a pre-registration `spawning` snapshot is
   truthful.
5. After `session.start()` resolves, verify the registry still owns the exact
   same entry. If kill/exit removed it, clean up and return `cancelled` instead
   of reporting a phantom live backend.
6. On expected startup failure, return `start-failed` with a safe message. In
   `finally`, release both recovery and spawning reservations so retry works.

`kill(sessionId)` must also see a recovery claim. It marks the claim cancelled,
terminates a backend if one has materialized, and ensures a later-resolving
startup is stopped before the recovery promise settles. This closes the
existing kill-during-start orphan race rather than merely testing around it.

Do not immediately kill main-owned sessions that are absent from one renderer
snapshot. During reload, renderer state is temporarily incomplete. Reverse
orphan reconciliation needs an explicit grace/lease design and is not part of
this fix.

## Delivery slices

Every slice follows red-green-refactor. Behavior and its regression tests land
together; there is no tests-later cleanup phase.

### Slice 1 — Main reconciliation authority and cancellation

**Production files**

- `src/main/sessionManager.ts`
- `src/main/ipc/session.ts`
- `src/preload/api/session.ts`
- `src/preload/api/types.ts`
- `src/shared/types/session.ts`

**First: caller census**

Use `rg` to enumerate every `spawnSession()` and every
`spawn({ preferredSessionId })` caller, including rehydrate, wake, undo-close,
clone, rewind, reload-all, and tests. Route persisted-id restoration through
`recover()`. Keep ordinary fresh-pane creation on `spawn()`.

**Tests first: `src/main/sessionManager.recover.test.ts`**

1. Matching live backend is adopted; provider creation is not called again.
2. Absent backend starts once under the requested local id.
3. Concurrent compatible recoveries join one startup and one provider.
4. A re-entrant recovery during provider creation still joins the synchronous
   claim.
5. Kind and normalized-cwd conflicts return typed failures without side
   effects.
6. Failed startup releases reservations and a later retry calls create again.
7. Recovery forwards saved MCP domains only on cold spawn.
8. Adoption of a live MCP-enabled backend calls neither `registerSession()`
   nor credential revocation; assert register count remains one.
9. Recovering a live backend while prompt delivery is in flight adopts it and
   does not treat normal work as an ownership conflict.
10. Kill during provider create/start cancels recovery and leaves no registry,
    process, proxy, or MCP registration behind.

**Snapshot tests**

- A pre-registration startup reports `lifecycle: 'spawning'` with kind/cwd
  from `spawnInfo`.
- A live entry reports cached readiness.
- Removed/cancelled sessions return `null`.

Use a fake provider whose create/start promises are controlled by explicit
deferreds. Do not use sleep-based races.

**Implementation notes**

- Preserve `spawningSessionIds`; make its relationship to the recovery claim
  explicit with thick WHY comments.
- The recovery map is bounded by in-flight lifetime and always released in
  `finally`.
- Add only `session:recover` and `session:get-backend-snapshot` IPC handlers.
- Unexpected programmer failures may reject, but ownership, cancellation, and
  provider-start failures use the discriminated result so renderer code never
  string-matches errors.

### Slice 2 — Stable-id rehydrate, pure projection, and failure retention

**Production files**

- `src/renderer/src/workspace/hook/persistence/rehydrate.ts`
- a small pure recovery-projection helper beside it
- `src/renderer/src/workspace/hook/actions/session.ts`

`rehydrate.ts` is already a large, timing-sensitive function. Extract only the
pure calculation that maps persisted leaves plus per-leaf recovery outcomes to
`freshSessions`, surviving leaves, and the resolved count. Keep effects and
incremental commits in the existing orchestrator.

**Tests first**

Pure projection tests:

1. Adopted and spawned leaves retain the original local id.
2. Failed/conflicted leaves remain in the layout with failed runtime metadata.
3. Hibernated detached/buried leaves remain metadata-only.
4. Completion becomes true once every visible leaf is resolved, including a
   retained failure; failed recovery cannot pin autosave off forever.

Renderer orchestration tests:

1. Renderer reload returns `adopted`; ids, focus, pins, dispatch lanes, and
   draft remain unchanged.
2. Full restart returns `spawned`; the same local id receives persisted resume
   and MCP launch inputs.
3. Two bootstrap attempts cannot create two providers.
4. A typed ownership conflict or start failure preserves the pane, marks it
   failed/unready, and exposes retry.
5. Retry calls recovery again and can replace failed runtime state with live
   state.

Mock expensive history hydration separately so these tests assert recovery
ownership rather than transcript rendering.

**Implementation notes**

- Replace direct visible-leaf `spawnSession()` calls with `recoverSession()`.
- Keep `idMap.set(oldId, oldId)` during the transition; remove only remap code
  proven rehydrate-specific by tests.
- Replace `spawnedIds` as the survival and completion source of truth. Track
  `resolvedIds` separately from successful backends.
- Build failed metadata/runtime before incremental commit.
- Change `ensureSessionLive()` to use the same main recovery API. Its renderer
  single-flight may remain to suppress redundant UI transitions, but it is not
  the ownership lock.

### Slice 3 — Level-triggered provider-attested composer readiness

Readiness must travel through the existing `SessionFeed` contract so local IPC
and remote WebSocket clients observe the same behavior.

**Production files**

- `src/shared/types/session.ts`
- `src/shared/sessionFeed/SessionFeed.ts`
- `src/shared/sessionFeed/types.ts`
- provider runtime files for Claude, Codex, and opencode
- `src/main/sessionManager.ts` and the existing session forwarder
- `src/renderer/src/features/sessionFeed/IpcSessionFeed.ts`
- `src/renderer/src/features/sessionFeed/FakeSessionFeed.ts`
- `src/remote-client/src/WebSocketSessionFeed.ts`
- `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts`

Add `onSessionInputReadiness` to `SessionFeed`. The recovery result supplies the
initial level; feed events supply changes. Subscribe before seeding and apply
only readiness revisions newer than the renderer's current revision. This
prevents both the subscribe-after-snapshot gap and a stale snapshot overwriting
a newer event.

Provider boundaries:

- **Claude:** starts unready. Emit the unready phase during bootstrap and emit
  ready from the existing `armLiveBridgeReady()` quiet-timer callback when
  `readyForLiveBridge` flips. Do not add a second timer.
- **Codex:** starts unready. Evaluate the existing composer predicate on normal
  screen snapshots and latch ready on its first success. Keep that latch across
  ordinary Working-to-idle turns; the composer is expected to disappear while
  Codex works, and re-evaluating it as false would flap the renderer disabled.
  Reset only on exit. Provider conditions remain a separate blocking channel.
- **opencode:** starts unready; successful `headless.start()` after history
  publication flips ready; server exit clears it.
- **terminal:** SessionManager marks ready when `TerminalSession.start()`
  succeeds.

Renderer rules:

- `session:started` means the process exists; it never grants input readiness.
- `session:process-state` updates activity/exit only; it never grants readiness.
- readiness snapshot/event is the only writer that turns `inputReady` true.
- `seedResumedRuntimeFields()` never infers readiness from a missing exit.
- reuse the existing `waitForSessionInputReady` path for finished-prompt
  delivery; do not build a parallel readiness waiter.

**Tests first**

1. Manager remains unready after `started` until the fake provider emits
   readiness.
2. FakeSessionFeed can remain started-but-unready, then emit readiness under
   test control.
3. IPC and WebSocket feed contract tests transport the same versioned event.
4. Late renderer adopts a live-ready backend and is immediately writable from
   its recovery snapshot.
5. Late renderer adopts a replaying backend and remains disabled until a newer
   event arrives.
6. A stale snapshot cannot overwrite a newer event.
7. Claude replay cannot acknowledge a newly armed prompt before its existing
   quiet gate.
8. Codex becomes ready from fake screen input and stays ready across a normal
   Working-to-idle turn.
9. Fresh non-resumed Claude/Codex/opencode sessions and terminal sessions each
   reach ready at their real startup boundary.
10. Exit clears readiness before or with the exit event.

### Slice 4 — Cross-layer restart regression

Add a narrow integration test beside the recovery seam. Wire:

1. a real `SessionManager` with a fake provider factory and fake built-in MCP
   host;
2. a tiny preload-shaped adapter that calls the real manager methods;
3. a `SessionFeed` fake/adapter carrying readiness;
4. persisted workspace metadata containing one visible agent;
5. two renderer bootstrap invocations against the same manager.

Assertions:

- first cold bootstrap creates exactly one provider and one MCP registration;
- second renderer bootstrap adopts it and creates neither another provider nor
  another MCP credential;
- local id, resume hint, MCP domains, layout, and draft survive;
- killing/removing the backend followed by bootstrap creates exactly one new
  provider under the same local id;
- create failure retains the pane and explicit retry succeeds;
- close during blocked startup cancels it and leaves no backend;
- ready/unready seeding is correct on both bootstraps.

The integration must use the real manager; a renderer test that merely counts
calls to a mocked `recoverSession()` cannot prove main-process atomicity. This
test is intentionally below packaged Electron and native PTY timing.

## Deferred follow-up — Provider resume identity acceptance

Atomic backend recovery answers “which process owns this pane?” It does not by
itself prove “did the provider accept this durable conversation id?” Do not
silently retain an old provider id if a cold resume actually fell back to a
fresh conversation.

Handle this in a separate focused plan/PR after the core protocol is green:

- Claude: expose a headless/tailer-backed resume-accepted or resume-rejected
  verdict and map rejection to an honest failed pane.
- Codex: first confirm the pinned `packages/codex-headless` surface. Add an
  old-to-new lineage/rebase verdict there if needed; do not reconstruct lineage
  heuristically in renderer code.
- Continue quarantining unrelated provider ids.

This follow-up is important, but inventing new cross-package identity proof is
not required to eliminate duplicate backend spawn or optimistic readiness and
must not block Slices 1–4.

## TDD execution order

1. Main recovery/cancellation unit tests.
2. Snapshot/readiness cache unit tests.
3. SessionFeed types, fake, IPC, and WebSocket contract tests.
4. Pure rehydrate projection tests, then renderer commit/failure tests.
5. Cross-layer restart integration.
6. Full owning projects, typecheck, and production build.

For each red-green loop:

1. Add the smallest failing test for one invariant.
2. Run that exact file and verify it fails for the intended missing behavior.
3. Implement only enough production behavior to pass.
4. Run the owning Vitest project.
5. Refactor with tests green and add thick WHY comments at ownership,
   cancellation, ordering, and readiness boundaries.

Suggested commands (adjust exact paths if colocated names differ):

```bash
npx vitest run --project unit src/main/sessionManager.recover.test.ts
npx vitest run --project renderer src/renderer/src/workspace/hook/persistence/rehydrate.renderer.test.ts
npx vitest run --project integration src/main/sessionRecovery.integration.test.ts
npm run test:unit
npm run test:renderer
npm run test:integration
npm run typecheck
```

Before the PR is reviewable:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

The repository currently has no lint script; do not claim a lint result for a
command that does not exist.

## Manual smoke matrix

| Scenario | Expected result |
| --- | --- |
| Renderer reload with idle Claude | Same local id/process/PID; no second proxy or MCP token |
| Renderer reload during Claude replay | Pane visible, composer disabled, later becomes ready |
| Full restart with Claude | New process, same local id, resume requested once |
| Full restart with Codex | Same ownership guarantee; resume rejection is not silently called success |
| Full restart with opencode | Server/history starts once; readiness follows startup |
| Visible provider binary missing | Pane/draft remain; failed state offers retry/setup |
| Detached/buried fleet | Metadata restores; providers remain hibernated |
| Workflow MCP enabled | Adopt keeps credential; cold restart registers exactly once |
| Two simultaneous wake triggers | One recovery claim and one provider constructor |
| Close pane during blocked startup | Startup is cancelled; no orphan backend appears |

## Observability and rollback

Reuse the existing `AppRunJournal` and performance diagnostics. Add only
metadata-only bounded records for:

- recovery disposition (`adopted`, `spawned`, joined as a diagnostic fact, or
  conflict);
- local session id, provider kind, and lifecycle duration;
- advisory readiness transition reason/revision;
- typed recovery failure code.

Do not build a new metrics subsystem. Duplicate-prevention counts belong in
tests, not a new production metric. Never log prompts, tool payloads, commands,
transcript text, MCP tokens, or credentials. Diagnostic failure must not delay
or fail recovery.

If provider readiness causes a regression, keep atomic local-id recovery and
temporarily gate finished-prompt delivery through the existing provider
per-delivery readiness check. Never roll back to renderer check-then-spawn or
optimistic `inputReady`.

## Claude orchestration review decisions

Four fresh Claude reviewers independently inspected the plan and relevant code
for concurrency, provider readiness, TDD seams, and scope. All returned
“approve with changes.” Their accepted changes are now part of this plan:

- synchronous recovery reservation and explicit `spawningSessionIds` census;
- cancellation semantics for kill-during-recovery;
- lexical cwd ownership conflicts to protect project-scoped MCP authority;
- resolved-outcome autosave semantics for retained failed panes;
- readiness transported through `SessionFeed` with monotonic revisions;
- Codex readiness latched across normal work instead of flapping;
- real fake-MCP and real-manager integration assertions;
- provider identity/rebase work and file movement deferred out of the core PR;
- speculative `listBackendSnapshots()` and new observability machinery removed.

The implementation should re-open these decisions only if a failing test or a
newly discovered repository invariant provides concrete contrary evidence.
