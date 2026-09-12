# Preserve application services when quitting is cancelled

Status: source revalidation and implementation plan for #919, B02 of #918 / program plan PR #931. This branch begins with this plan; no implementation precedes it.

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
