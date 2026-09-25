# Preserve application services when quitting is cancelled

Status: first B02 disposal repair implemented locally; final verification and PR preparation in progress. Tracking #919 and #918 / program plan PR #931. The branch began with this plan in commit `841d094913a7e61bce35cfafea1786050bd3b4f2`; no implementation preceded it.

Baseline: `115e26fc9c67316a3b0b1b4318f47f7a2bea3606`, current `origin/main` on 2026-09-12. It includes the skills and TLDR changes from #903/#932. It does not include unmerged tmux PR #933 or session-routing PR #935. The quit handlers are unchanged by those merged features. Do not assume either independent recovery slice has merged.

## Confirmed seam and intended outcome

`src/main/index.ts` stops workflows from `before-quit`, re-enters quit, then starts MCP, remote, LSP, dictation, caffeinate, watchdog and persistence teardown before a renderer can reject closing. `SessionShutdownGate` correctly waits for `will-quit` before permanent session teardown, but that gate cannot protect disposals elsewhere. `appWindow.ts` implements Keep Editing through Electron's `will-prevent-unload`, and the real editor guard checks current project/AI Workspace buffer state at each unload.

After a veto, every previously working service must still be usable. After committed shutdown, the app must retain one exact drain attempt, reject new conflicting admission, await required drains, and mark clean/release the process lock only after those drains are confirmed. A rejected or uncertain stop must retain ownership and retry/inspection facilities. Successful drains must not be repeated merely because another drain failed.

## Delivery boundaries

The first bounded implementation fixes application-wide disposal composition and required exit drains. It preserves the existing native per-window editor decision UX and the current session shutdown gate's one-way terminal-admission fact. Preparation may flush observations but may not cancel workflows, stop providers, dispose support services, or mark the process clean.

The complete B02 program ALSO requires a quit-attempt generation, renderer/buffer revision-bound decisions, participant revalidation and a short stable revision frontier before commit. Keep that work explicit under #919. If this branch's first PR does not yet implement that whole preparation protocol, use **Refs #919**, retain the remaining acceptance criteria, and continue its dependent slice. Do not claim that relocating disposals by itself completes B02 or that an old editor approval can authorize a later edit revision.

## Implementation sequence

1. Initialize the seven pinned package checkouts and isolated dependencies; run existing shutdown gate and editor unload tests. Inspect all app quit/last-window listeners, service construction/disposal owners, and the new TLDR hook resources. Record which resources exist during partial startup.
2. Build one inspectable application shutdown composition at the real main entry point. Inventory reversible preparation, required producer stops, required persistence drains, support disposal, best-effort diagnostics and final synchronous release. Keep ownership and dependency order explicit in WHY comments beside the wiring.
3. Keep irreversible effects behind committed shutdown. Publish that state before the first destructive await; repeated quit requests join the exact attempt. Audit spawn/recovery, workflow admission, activation and new-window routes so a failed committed shutdown cannot reopen an unusable ordinary workspace.
4. Retain service references until their required stop is confirmed. Await workflow/session ownership release and required stores; do not replace missing evidence with a timer, one event-loop tick or registry removal. Retain completed-stage receipts and retry only unresolved drains. Keep diagnostic/inspection services available while native release remains uncertain.
5. Integrate external control/settings disposal with the same exit gate instead of an independent fire-and-forget `will-quit` listener. Preserve macOS last-window behavior and failed-startup cleanup. Do not introduce a second provider cleanup owner or weaken Codex/native custody.
6. Exercise the real composition through before-quit, actual editor-veto behavior, and will-quit. Verify workflow/MCP/LSP/dictation calls still work after veto; verify exact drain joins, failure/retry, no early clean marker, partial startup, non-macOS last-window ordering and post-commit admission. Mock OS/process boundaries rather than the coordinator's own caller.
7. Run proportionate checks, review every irreversible call site, update this plan for substantive decisions, open a complete linked PR and inspect current-head CI/reviews. Record the revision-bound preparation work accurately in #919/#918. No PR merge without explicit user authorization.

## Verification and scope rules

A unit test that calls only `SessionShutdownGate` cannot expose a rogue main `before-quit` disposer. The composed regression must include the caller that owns those service references. A mock stop result proves coordinator sequencing, not native process termination. Native ownership remains governed by each existing service contract and its separate program tests.

Keep the window-routing repair and tmux changes independent. Do not modify native transcripts, stop live user sessions, or use a live application Quit as a routine test. Local tests must own their processes/state. If a live smoke is later useful, make its isolation and resource ownership concrete first.


## Implementation checkpoint

The application disposal inventory now lives in `applicationShutdown.ts`, installed by the real main entry point. `before-quit` only records reversible preparation and flushes observations; it skips that preparation on re-entry after commitment so it cannot enqueue new work behind the final drains. `SessionShutdownGate` retains its existing terminal-admission facade, but takes the complete application drain rather than inferring an empty inventory from a missing manager. It publishes the exact join before calling potentially reentrant/synchronously throwing shutdown code. Non-macOS last-window closure requests this same quit path; macOS still leaves the app running.

Execution stops begin together. Stage receipts retain completed work across retry and preserve failed owners. Main keeps workflow/control inspection infrastructure until session and workflow stop contracts resolve. A failed drain holds the exit gate and process lock, with a later Quit retrying unresolved stages. Support disposal, admitted write-tail settlement and optional diagnostic flushing are separate stages.

Partial startup required more than moving listeners. The workflow factory publishes its owner before `initialize`, whose existing stop contract already closes recovery admission and joins initialization. Main checks committed shutdown after asynchronous resource acquisition and the coordinator joins startup before closing its resource inventory. Failed startup retains the lock through cleanup and does not receive a clean-run marker. A typed workflow-closing outcome caused by committed quit is treated as interrupted startup. The common window factory fences restoration, menu, IPC and external-control creation after commitment.

The composition audit exposed two concrete owner gaps that this same slice repairs:

- Dictation's active map excludes stop handlers awaiting batch HTTP. Committed cleanup now fences new operations, aborts owned batch HTTP, joins admitted start/stop/hotkey work, cancels active/stopping previews and fences their late observations, then captures the history write tail. A key lookup or hotkey configuration finishing late cannot revive a resource behind cleanup.
- Remote disposal previously bypassed the enable/disable FIFO and erased its server pointer before a stop resolved. Disposal now closes enable admission, joins that FIFO, prevents a pending enable from publishing a live URL, and keeps the exact server on rejection for an explicit retry.

The shutdown section of `ARCHITECTURE.md` and its generated preview now describe the implemented boundary. All 42 diagram sources rendered and verified with the pinned documentation tools; only the changed shutdown preview is retained. Five unrelated previews differed when regenerated in this local Chrome environment; those generated changes were discarded. The shutdown SVG was visually inspected independently.

## Evidence and limits of this slice

The expanded unit lane passed 57 cases across seven files; the final coordinator/gate/dictation subset passed 19 cases after the drain-order review. The real remote stack suite passed nine system cases, including delayed start and failed transport release. The real renderer editor guard composed with the application listener installer passed its veto/clean-close test. External boundaries in those tests are Electron dispatch, provider HTTP, transport or filesystem operations as appropriate; no live user application was quit.

Full typecheck, the test-contract checker and all seven pinned-checkout checks passed. Final-source incremental typecheck, application build/entrypoint verification, final targeted checks and PR CI are recorded below as they finish. The first renderer fixture assertion used the wrong buffer field (`text` instead of `currentText`); it was corrected and the renderer test passed. No product behavior was changed to satisfy that assertion.

This PR uses **Refs #919**, not an issue-closing keyword. B02 remains open for the full revision-bound prepare/commit protocol. In particular:

- Native per-window decisions are not yet votes bound to a quit generation, renderer generation and buffer revision. Cross-window edits, navigation and changing participants still need final revalidation and a short stable admission frontier.
- `WorkspaceFileStore.drainAdmittedWrites` and `flushHistoryWrites` join their existing admission tails. Each original write still owns its failure receipt. These APIs do not recover an unacknowledged final renderer save, retry a rejected write, or establish fsync durability.
- The remaining frontier must explicitly cover already-admitted control operations and their durable result writes. `createControlHost.dispose()` currently retires bridge registrations synchronously; it is not an awaitable guarantee that every executor operation and `FileControlHistory` append has settled. This slice does not add that missing contract or claim that the clean-run marker proves it.
- Support disposal establishes the current service API's promise. LSP's current dispose requests process termination without independent exit evidence; its process/document ownership audit remains in B04. Optional diagnostics report write errors separately. Native provider custody is not redefined by this coordinator.

The bounded result is preservation of services on veto and one explicit composition of existing committed-stop/drain contracts, including the two owner gaps above. It is not completion of every quit durability or editor approval invariant in the program.

The next control frontier audit starts at `src/main/control/createControlHost.ts`, `src/control-sdk/core/executor.ts` and `src/main/control/history/FileControlHistory.ts`. The executor's `active` map is populated only after its admitted intent write, so draining that map alone would miss a request still queued in `exclusive`. Nested waits/batches also call the executor directly. Main's private `operations.start`/`operations.finish` port must keep completion receipts writable while new effectful work is closed; a blanket rejection of all invocation would lose the evidence shutdown needs. Keep these facts in the next focused B02 plan.


## Final provider-boundary review

The first app build and entrypoint verification passed. Review of the actual pinned voice package then exposed why merely awaiting dictation promises was insufficient: batch HTTP has no default application deadline, and preview `cancel()` removes the session before `finalizeSession` can resolve an earlier `stop()` promise. The final implementation propagates an AbortSignal through the real main controller to the pinned HTTP provider, aborts owned batch work on committed quit, and joins its handler. It cancels previews through the existing API and suppresses late optional debug writes instead of awaiting an abandoned preview-stop promise. Already-completed batch results may still enqueue history before their handler settles; the subsequent tail includes those writes.

A fourth dictation regression exercises IPC → real controller → pinned provider → abortable HTTP boundary. The coordinator/dictation review lane passed 13 cases, including cancellation and an intentionally unresolved optional preview promise. This adds one unique unit case to the previous totals (58 unit, nine remote system, one renderer). Repeat final-source checks/build after this substantive correction; do not cite the earlier app build as verification of the cancellation change.

New problem records from the composition audit: #941 remote disposal (implemented), #942 pending dictation cleanup (implemented), #943 control admission/result drain (follow-up, not implemented). The first two are independently closeable by this PR; #919/#943/#918 remain open. The conventions require these separate issue records even though the implementation shares the quit-safety PR.
